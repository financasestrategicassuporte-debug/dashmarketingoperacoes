// api/data.js
// Puxa os leads diretamente da planilha do Google Sheets (exportação CSV pública)
// e devolve no formato que o dashboard (index.html) já espera em `leadsList`.
//
// A planilha precisa estar como "Qualquer pessoa com o link -> Leitor".
// Você pode trocar a planilha/aba sem editar código, via variáveis de ambiente
// na Vercel: SHEET_ID e SHEET_GID.

const SHEET_ID = process.env.SHEET_ID || '1MW_dyf0VOHULceCCtY7FkCR_tLCCkM6YqPY-TQd8fjI';
const SHEET_GID = process.env.SHEET_GID || '1467696356';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

// ---------- CSV parsing (sem dependências externas) ----------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // ignora, o \n do CRLF trata a quebra de linha
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- Faturamento -> valor numérico para classificação ----------
function parseFaturamento(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  const hasMil = /mil\b/i.test(s);
  const hasK = /\d\s*k\b/i.test(s);

  // "R$30.000" ou "30.000" -> remove o ponto de milhar (formato BR)
  let cleaned = s.replace(/R\$\s?/gi, '').replace(/(\d)\.(\d{3})(?!\d)/g, '$1$2');

  const nums = cleaned.match(/\d+(?:[.,]\d+)?/g);
  if (!nums) return null;

  let vals = nums.map((n) => parseFloat(n.replace(',', '.')));
  if (hasK || hasMil) vals = vals.map((v) => (v < 1000 ? v * 1000 : v));

  if (!vals.length) return null;
  // usa o limite inferior da faixa (mais conservador para qualificação)
  return Math.min(...vals);
}

function qualificationFor(value) {
  if (value == null) {
    return { qual: 'Sem dado de faturamento', qualBg: '#f3f4f6', qualColor: '#6b7280' };
  }
  if (value >= 100000) return { qual: 'Ultra Qualif. (+100k)', qualBg: '#f5f3ff', qualColor: '#7c3aed' };
  if (value >= 50000) return { qual: 'Qualificado (+50k)', qualBg: '#eff6ff', qualColor: '#2563eb' };
  if (value >= 30000) return { qual: 'Semi Qualif. (+30k)', qualBg: '#fffbeb', qualColor: '#b45309' };
  return { qual: 'Não Qualificado', qualBg: '#f9fafb', qualColor: '#6b7c72' };
}

// ---------- Datas: a planilha tem 2 formatos misturados ----------
// "16/07/2026, 21:37:51"  -> DD/MM/YYYY (com vírgula)
// "7/16/2026 12:31:46"    -> M/D/YYYY   (sem vírgula, formato US)
function parseRowDate(raw) {
  if (!raw) return null;
  const s = raw.trim();
  const hasComma = s.includes(',');
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;

  let [, p1, p2, year, h, min, sec] = m;
  let day, month;
  if (hasComma) { day = p1; month = p2; } // DD/MM/YYYY
  else { month = p1; day = p2; } // M/D/YYYY

  const d = new Date(Number(year), Number(month) - 1, Number(day), Number(h), Number(min), Number(sec || 0));
  return isNaN(d.getTime()) ? null : d;
}

function rangeToWindow(range) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = startOfDay(now);
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

  switch (range) {
    case 'Hoje': return { start: today, end: addDays(today, 1) };
    case 'Ontem': return { start: addDays(today, -1), end: today };
    case 'Essa Semana': {
      const dow = today.getDay(); // 0=domingo
      return { start: addDays(today, -dow), end: addDays(today, 1) };
    }
    case 'Esse Mês': return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: addDays(today, 1) };
    case 'Mês Passado': return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      end: new Date(now.getFullYear(), now.getMonth(), 1),
    };
    case '7 dias': return { start: addDays(today, -7), end: addDays(today, 1) };
    case '14 dias': return { start: addDays(today, -14), end: addDays(today, 1) };
    case '30 dias': return { start: addDays(today, -30), end: addDays(today, 1) };
    case '90 dias': return { start: addDays(today, -90), end: addDays(today, 1) };
    default: return null; // sem filtro
  }
}

// ---------- Auxiliares de exibição ----------
const AVATAR_COLORS = ['#7c3aed', '#2563eb', '#16a34a', '#f59e0b', '#0891b2', '#dc2626'];

function initialsOf(name) {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '??';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function formatDataLabel(date) {
  if (!date) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getDate())}/${p(date.getMonth() + 1)} · ${p(date.getHours())}h`;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  try {
    const csvRes = await fetch(CSV_URL);
    if (!csvRes.ok) throw new Error(`Falha ao buscar a planilha (HTTP ${csvRes.status})`);
    const csvText = await csvRes.text();

    const rows = parseCSV(csvText).filter((r) => r.some((cell) => (cell || '').trim() !== ''));
    if (!rows.length) throw new Error('Planilha vazia');

    // Descobre a linha de cabeçalho (a primeira com "Nome" numa das colunas)
    const headerIdx = rows.findIndex((r) => r.some((c) => /nome/i.test(c)));
    const header = headerIdx >= 0 ? rows[headerIdx] : rows[0];
    const dataRows = rows.slice((headerIdx >= 0 ? headerIdx : 0) + 1);

    const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
    const idx = {
      data: col('Data/Hora'),
      nome: col('Nome'),
      whatsapp: col('WhatsApp'),
      email: col('Email'),
      faturamento: col('Faturamento'),
      area: col('Área'),
      utmCampaign: col('utm_campaign'),
      utmContent: col('utm_content'),
    };

    const { range } = req.query || {};
    const window = range ? rangeToWindow(range) : null;

    const leads = [];
    dataRows.forEach((r, i) => {
      const nome = idx.nome >= 0 ? (r[idx.nome] || '').trim() : '';
      if (!nome) return; // ignora linhas incompletas (sem nome preenchido)

      const dateRaw = idx.data >= 0 ? r[idx.data] : '';
      const parsedDate = parseRowDate(dateRaw);

      if (window && parsedDate && (parsedDate < window.start || parsedDate >= window.end)) return;

      const faturamentoRaw = idx.faturamento >= 0 ? (r[idx.faturamento] || '').trim() : '';
      const faturamentoValor = parseFaturamento(faturamentoRaw);
      const q = qualificationFor(faturamentoValor);

      leads.push({
        nome,
        initials: initialsOf(nome),
        avatarBg: AVATAR_COLORS[i % AVATAR_COLORS.length],
        camp: (idx.utmCampaign >= 0 ? r[idx.utmCampaign] : '') || '(sem campanha)',
        renda: faturamentoRaw || '-',
        cargo: (idx.area >= 0 ? r[idx.area] : '') || '-',
        qual: q.qual,
        qualBg: q.qualBg,
        qualColor: q.qualColor,
        data: formatDataLabel(parsedDate),
        _faturamentoValor: faturamentoValor,
        _campaignRaw: (idx.utmCampaign >= 0 ? r[idx.utmCampaign] : '') || '',
        _contentRaw: (idx.utmContent >= 0 ? r[idx.utmContent] : '') || '',
      });
    });

    // Agrupa por criativo (utm_content) só com o que dá pra saber pela planilha:
    // quantidade de leads e quantos qualificados. Custo/CTR/CPC dependem da API
    // do Meta Ads e não estão nesta planilha — ficam como "-" aqui.
    const byContent = new Map();
    leads.forEach((l) => {
      const key = l._contentRaw || '(sem criativo)';
      if (!byContent.has(key)) byContent.set(key, { nome: key, camp: l._campaignRaw, leads: 0, qualif: 0 });
      const g = byContent.get(key);
      g.leads += 1;
      if (l._faturamentoValor != null && l._faturamentoValor >= 50000) g.qualif += 1;
    });

    const rankColors = ['#16a34a', '#2563eb', '#94a3b8', '#94a3b8', '#94a3b8', '#94a3b8'];
    const creativesList = Array.from(byContent.values())
      .sort((a, b) => b.qualif - a.qualif || b.leads - a.leads)
      .slice(0, 6)
      .map((g, i) => ({
        rank: i + 1,
        rankBg: rankColors[i] || '#94a3b8',
        cardBg: i === 0 ? '#f6fdf8' : '#f9fbf9',
        cardBorder: i === 0 ? '#bbf7d0' : '#e8ece8',
        tag: g.qualif > 0 ? 'COM LEAD QUALIF.' : 'SEM LEAD QUALIF.',
        tagBg: g.qualif > 0 ? '#dcfce7' : '#fef3c7',
        tagColor: g.qualif > 0 ? '#15803d' : '#b45309',
        nome: g.nome,
        camp: g.camp,
        cpl: '-',
        cplq: '-',
        cplqColor: '#93a29a',
        qualif: String(g.qualif),
        invest: '-',
        ctr: '-',
        leads: String(g.leads),
      }));

    // remove os campos internos (_...) antes de responder
    const leadsList = leads.map(({ _faturamentoValor, _campaignRaw, _contentRaw, ...rest }) => rest)
      .sort((a, b) => (a.data < b.data ? 1 : -1));

    res.status(200).json({ leadsList, creativesList, source: 'google-sheets', fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
