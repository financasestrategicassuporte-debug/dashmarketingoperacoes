// api/data.js  —  Vercel Serverless Function (Node 18+)
// Endpoint que o dashboard consome: GET /api/data?range=7 dias&source=Meta&funnel=Geral
//
// O que ele faz:
//   1. Puxa insights da conta Meta (nível de anúncio) via Graph API.
//   2. Lê a planilha de leads (Google Sheets, com o taggeamento por campanha).
//   3. Cruza os dois: agrupa leads por tag de campanha, calcula CPL e CPL qualificado.
//   4. (Opcional) Busca a taxa de conexão medida na página do workshop (Supabase).
//   5. Devolve o JSON JÁ no formato que o front espera (leadsList / creativesList / kpis).
//
// Variáveis de ambiente esperadas (Settings > Environment Variables no Vercel):
//   META_ACCESS_TOKEN   -> token de System User com permissão ads_read (NÃO é o conector do Claude)
//   META_AD_ACCOUNT_ID  -> 762597382480878   (sem o prefixo "act_")
//   SHEET_CSV_URL       -> URL de exportação CSV da planilha (ver README)
//   ICP_MIN_FATURAMENTO -> limiar de faturamento p/ lead "qualificado" (default 40000)
//   SUPABASE_URL        -> (opcional) para a taxa de conexão do workshop
//   SUPABASE_SERVICE_KEY-> (opcional)

const GRAPH_VERSION = 'v21.0';

// ---- mapa dos botões de período do dashboard -> date_preset da Meta ----
const RANGE_TO_PRESET = {
  'Hoje': 'today',
  'Ontem': 'yesterday',
  'Essa Semana': 'this_week_mon_today',
  'Esse Mês': 'this_month',
  'Mês Passado': 'last_month',
  '7 dias': 'last_7d',
  '14 dias': 'last_14d',
  '30 dias': 'last_30d',
  '90 dias': 'last_90d',
};

// ============================ HANDLER ============================
export default async function handler(req, res) {
  // CORS: o dashboard pode rodar em outro domínio Vercel
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const range = req.query.range || '7 dias';
  const preset = RANGE_TO_PRESET[range] || 'last_7d';
  const icpMin = Number(process.env.ICP_MIN_FATURAMENTO || 40000);

  try {
    // Roda as duas fontes em paralelo
    const [insights, leadsRaw] = await Promise.all([
      fetchMetaInsights(preset),
      fetchSheetLeads(),
    ]);

    const connectRate = await fetchConnectRate(preset).catch(() => null);

    const payload = crossReference(insights, leadsRaw, { icpMin, connectRate });
    payload.updatedAt = new Date().toISOString();
    payload.range = range;

    // cache leve na borda (5 min) — bate com o auto-refresh do front
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('[api/data] erro:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ==================== 1) META GRAPH API ====================
async function fetchMetaInsights(datePreset) {
  const token = process.env.META_ACCESS_TOKEN;
  const acct = process.env.META_AD_ACCOUNT_ID;
  if (!token || !acct) throw new Error('META_ACCESS_TOKEN / META_AD_ACCOUNT_ID não configurados');

  const fields = [
    'ad_id', 'ad_name', 'adset_name', 'campaign_name',
    'spend', 'impressions', 'clicks', 'ctr',
    'actions', 'cost_per_action_type',
  ].join(',');

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/act_${acct}/insights`
    + `?level=ad&fields=${fields}&date_preset=${datePreset}&limit=500&access_token=${token}`;

  const rows = [];
  let next = url;
  // paginação
  while (next) {
    const r = await fetch(next);
    const j = await r.json();
    if (j.error) throw new Error('Meta API: ' + j.error.message);
    rows.push(...(j.data || []));
    next = j.paging && j.paging.next ? j.paging.next : null;
  }

  // normaliza cada anúncio
  return rows.map((row) => {
    const leadAction = (row.actions || []).find((a) =>
      a.action_type === 'lead'
      || a.action_type === 'onsite_conversion.lead_grouped'
      || a.action_type === 'offsite_conversion.fb_pixel_lead'
    );
    const leads = leadAction ? Number(leadAction.value) : 0;
    const spend = Number(row.spend || 0);
    return {
      adId: row.ad_id,
      adName: row.ad_name,
      campaign: row.campaign_name || '',
      spend,
      impressions: Number(row.impressions || 0),
      clicks: Number(row.clicks || 0),
      ctr: Number(row.ctr || 0),
      leads,
      cpl: leads > 0 ? spend / leads : null,
    };
  });
}

// ==================== 2) GOOGLE SHEETS ====================
async function fetchSheetLeads() {
  const csvUrl = process.env.SHEET_CSV_URL;
  if (!csvUrl) throw new Error('SHEET_CSV_URL não configurada');
  const r = await fetch(csvUrl);
  if (!r.ok) throw new Error('Planilha inacessível (HTTP ' + r.status + ')');
  const text = await r.text();
  return parseCsv(text);
}

// parser CSV simples que respeita aspas e vírgulas dentro de campo
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const split = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = split(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] || '').trim(); });
    return obj;
  });
}

// tenta achar uma coluna por vários nomes possíveis (a planilha pode variar)
function pick(obj, ...keys) {
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const map = {};
  Object.keys(obj).forEach((k) => { map[norm(k)] = obj[k]; });
  for (const k of keys) {
    const v = map[norm(k)];
    if (v !== undefined && v !== '') return v;
  }
  return '';
}

// R$ 150.000  ->  150000
function parseMoney(s) {
  if (!s) return 0;
  const digits = String(s).replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

// ==================== 3) CRUZAMENTO ====================
function crossReference(insights, leads, { icpMin, connectRate }) {
  // ---- normaliza leads da planilha ----
  const normLeads = leads.map((row) => {
    const nome = pick(row, 'nome', 'name', 'lead', 'nome completo') || '—';
    const camp = pick(row, 'campanha', 'campaign', 'utm_campaign', 'tag', 'trackeamento') || '';
    const rendaNum = parseMoney(pick(row, 'faturamento', 'faixa de faturamento mensal', 'renda', 'faturamento mensal'));
    const cargo = pick(row, 'cargo', 'funcao', 'role') || '';
    const dataLead = pick(row, 'data', 'timestamp', 'carimbo de data/hora', 'data/hora') || '';
    const qualificado = rendaNum >= icpMin;
    return { nome, camp, rendaNum, cargo, dataLead, qualificado };
  });

  // ---- agrupa leads por campanha (tag) ----
  const byCampaign = {};
  for (const l of normLeads) {
    const key = l.camp || '(sem tag)';
    (byCampaign[key] = byCampaign[key] || []).push(l);
  }

  // ---- creativesList: um card por anúncio, cruzando com leads qualificados ----
  const creatives = insights.map((ad) => {
    // match: leads cuja tag contém o nome da campanha do anúncio (ou vice-versa)
    const matched = normLeads.filter((l) =>
      l.camp && ad.campaign && (
        ad.campaign.includes(l.camp) || l.camp.includes(ad.campaign)
      )
    );
    const qualif = matched.filter((l) => l.qualificado).length;
    const cplq = qualif > 0 ? ad.spend / qualif : null;
    return { ...ad, qualif, cplq };
  })
  .sort((a, b) => {
    // ranqueia por menor CPL qualificado; quem não tem lead vai pro fim
    if (a.cplq == null && b.cplq == null) return b.spend - a.spend;
    if (a.cplq == null) return 1;
    if (b.cplq == null) return -1;
    return a.cplq - b.cplq;
  })
  .map((ad, idx) => toCreativeCard(ad, idx));

  // ---- leadsList: top leads qualificados, formatados pro front ----
  const leadsList = normLeads
    .filter((l) => l.rendaNum > 0)
    .sort((a, b) => b.rendaNum - a.rendaNum)
    .slice(0, 30)
    .map((l) => toLeadCard(l, icpMin));

  // ---- KPIs agregados ----
  const totalSpend = insights.reduce((s, a) => s + a.spend, 0);
  const totalLeads = insights.reduce((s, a) => s + a.leads, 0);
  const qualifLeads = normLeads.filter((l) => l.qualificado).length;
  const kpis = {
    investimento: brl(totalSpend),
    leads: totalLeads,
    leadsQualificados: qualifLeads,
    cpl: totalLeads > 0 ? brl(totalSpend / totalLeads) : '—',
    cplQualificado: qualifLeads > 0 ? brl(totalSpend / qualifLeads) : '—',
    taxaConexao: connectRate != null ? (connectRate * 100).toFixed(2) + '%' : null,
  };

  return { kpis, leadsList, creativesList: creatives };
}

// ---- formatação de card de criativo (mesmos campos que o front já usa) ----
function toCreativeCard(ad, idx) {
  const rank = idx + 1;
  const rankBg = rank === 1 ? '#16a34a' : rank === 2 ? '#2563eb' : '#94a3b8';
  const semLead = ad.leads === 0;
  const escalar = rank === 1 && ad.qualif > 0;
  const tag = escalar ? 'ESCALAR' : semLead ? 'SEM LEAD' : 'TESTE';
  const tagBg = escalar ? '#dcfce7' : semLead ? '#fef3c7' : '#eff6ff';
  const tagColor = escalar ? '#15803d' : semLead ? '#b45309' : '#2563eb';
  return {
    rank, rankBg,
    cardBg: escalar ? '#f6fdf8' : '#f9fbf9',
    cardBorder: escalar ? '#bbf7d0' : '#e8ece8',
    tag, tagBg, tagColor,
    nome: ad.adName || '—',
    camp: ad.campaign || '—',
    cpl: ad.cpl != null ? brl(ad.cpl) : '-',
    cplq: ad.cplq != null ? brl(ad.cplq) : '-',
    cplqColor: ad.cplq != null && rank === 1 ? '#16a34a' : ad.cplq != null ? '#16241d' : '#93a29a',
    qualif: String(ad.qualif),
    invest: brl(ad.spend),
    ctr: (ad.ctr || 0).toFixed(2) + '%',
    leads: String(ad.leads),
  };
}

// ---- formatação de card de lead (mesmos campos que o front já usa) ----
function toLeadCard(l, icpMin) {
  const ultra = l.rendaNum >= 100000;
  const qualif = l.rendaNum >= icpMin;
  const palette = ['#7c3aed', '#f59e0b', '#2563eb', '#16a34a', '#dc2626'];
  const initials = l.nome.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return {
    nome: l.nome,
    initials,
    avatarBg: palette[l.nome.length % palette.length],
    camp: l.camp || '—',
    renda: brl(l.rendaNum),
    cargo: l.cargo || '—',
    qual: ultra ? 'Ultra Qualif. (+100k)' : qualif ? 'Qualificado (+' + Math.round(icpMin / 1000) + 'k)' : 'Desqualificado',
    qualBg: ultra ? '#f5f3ff' : qualif ? '#eff6ff' : '#fef2f2',
    qualColor: ultra ? '#7c3aed' : qualif ? '#2563eb' : '#dc2626',
    data: l.dataLead || '—',
  };
}

// ==================== 4) TAXA DE CONEXÃO (workshop) ====================
// A "taxa de conexão" = quem realmente abriu/assistiu a página do workshop
// dividido por quem se inscreveu. Isso precisa de uma fonte que MEÇA a página.
// Implementação padrão: uma tabela no Supabase (workshop_presence) que a
// própria página do workshop alimenta (ver snippet no README).
async function fetchConnectRate(datePreset) {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) return null; // sem fonte -> front mostra demo

  // conta inscritos e conectados na tabela
  const q = async (filter) => {
    const r = await fetch(`${sbUrl}/rest/v1/workshop_presence?select=id${filter}`, {
      headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey, Prefer: 'count=exact' },
    });
    return Number(r.headers.get('content-range')?.split('/')?.[1] || 0);
  };
  const inscritos = await q('');
  const conectados = await q('&connected=eq.true');
  return inscritos > 0 ? conectados / inscritos : null;
}

// ==================== util ====================
function brl(n) {
  return 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
