# Backend do Dashboard de Funis (GFB)

Este backend é a peça que faltava: o seu dashboard já tinha o gancho `DATA_ENDPOINT`,
mas não existia nenhum servidor por trás dele. Este projeto cria o endpoint
`/api/data` que cruza **Meta Ads + planilha de leads + taxa de conexão do workshop**
e devolve o JSON no formato que o dashboard já entende.

## Arquitetura (o ponto mais importante)

```
[Meta Graph API]  ┐
[Google Sheets ]  ├──►  /api/data (Vercel)  ──►  Dashboard (front)
[Supabase workshop]┘
```

> ⚠️ O "conector Meta" que você usa dentro do Claude **NÃO** funciona num app publicado.
> Ele vive só na sessão do Claude. Um app na Vercel precisa do **token próprio** dele
> (System User token com permissão `ads_read`). É o passo 1 abaixo.

---

## Passo 1 — Token da Meta (ads_read)

1. Acesse **business.facebook.com → Configurações do Negócio → Usuários → Usuários do sistema**.
2. Crie um *System User* (ou use um existente) e clique em **Gerar novo token**.
3. Selecione o app, marque a permissão **`ads_read`** e gere.
4. Copie o token. Guarde para o passo 4 (`META_ACCESS_TOKEN`).
   - O `META_AD_ACCOUNT_ID` já é o seu: **762597382480878**.

## Passo 2 — Liberar a planilha como CSV

O backend lê a planilha por uma URL de CSV. Escolha uma das opções:

**Opção A (mais simples):** compartilhar como "qualquer pessoa com o link pode ver" e usar:
```
https://docs.google.com/spreadsheets/d/1MW_dyf0VOHULceCCtY7FkCR_tLCCkM6YqPY-TQd8fjI/export?format=csv&gid=1467696356
```

**Opção B (mais controlada):** Arquivo → Compartilhar → **Publicar na web** → aba certa → CSV.
Copie a URL gerada.

Coloque a URL escolhida em `SHEET_CSV_URL`.

> Colunas que o backend tenta reconhecer (aceita variações de nome, com/sem acento):
> `nome`, `campanha` (a tag de trackeamento), `faturamento` / `Faixa de faturamento Mensal`,
> `cargo`, `data`. Se o nome for diferente na sua planilha, me avise que ajusto o mapeamento.

## Passo 3 — Taxa de conexão do workshop (opcional agora)

A "taxa de conexão" é *quem realmente abriu/assistiu* a página do workshop ÷ *quem se inscreveu*.
Isso precisa de uma fonte que meça a página `workshopgestaofitness-odt6.vercel.app`.

Cole este trecho no `<head>` daquela página (usa o Supabase que você já tem):

```html
<script>
  (async () => {
    const SB = 'https://SEU-PROJETO.supabase.co';
    const KEY = 'SUA_ANON_KEY';
    const lead = new URLSearchParams(location.search).get('lead') || 'anon';
    await fetch(SB + '/rest/v1/workshop_presence', {
      method: 'POST',
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY,
                 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ lead_id: lead, connected: true, seen_at: new Date().toISOString() })
    });
  })();
</script>
```

Tabela no Supabase:
```sql
create table workshop_presence (
  lead_id text primary key,
  connected boolean default false,
  seen_at timestamptz default now()
);
```
Depois preencha `SUPABASE_URL` e `SUPABASE_SERVICE_KEY` no Vercel. Sem isso, o dashboard
simplesmente mostra o número em modo demo — nada quebra.

## Passo 4 — Deploy na Vercel

```bash
npm i -g vercel      # se ainda não tiver
cd funilgfb
vercel                # primeira vez: cria o projeto
vercel --prod         # publica
```

Depois, em **Vercel → Project → Settings → Environment Variables**, adicione:

| Variável | Valor |
|---|---|
| `META_ACCESS_TOKEN` | (passo 1) |
| `META_AD_ACCOUNT_ID` | `762597382480878` |
| `SHEET_CSV_URL` | (passo 2) |
| `ICP_MIN_FATURAMENTO` | `40000` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | (passo 3, opcional) |

Refaça `vercel --prod` para aplicar as variáveis.

## Passo 5 — Ligar o dashboard ao backend

No arquivo `Dashboard_de_Funis_CONECTADO.html`, procure a linha:
```js
DATA_ENDPOINT = 'https://SEU-BACKEND.vercel.app/api/data';
```
Troque pelo domínio real que a Vercel te deu no passo 4. Publique esse HTML
(pode ser o mesmo projeto ou outro). Pronto — a bolinha de status fica verde
("conectado à Meta") e a lista de leads + ranking de criativos passam a vir reais.

## Testar o endpoint sozinho

```
https://SEU-BACKEND.vercel.app/api/data?range=7 dias&source=Meta&funnel=Geral
```
Deve devolver um JSON com `kpis`, `leadsList`, `creativesList` e `updatedAt`.

## Contrato do JSON (o que o front espera)

```jsonc
{
  "kpis": {
    "investimento": "R$ 4.768,60",
    "leads": 4,
    "leadsQualificados": 3,
    "cpl": "R$ 1.192,15",
    "cplQualificado": "R$ 1.589,53",
    "taxaConexao": "88.24%"        // ou null se não configurado
  },
  "leadsList": [
    { "nome":"...", "initials":"..", "avatarBg":"#..", "camp":"[FSS]_...",
      "renda":"R$ 150.000", "cargo":"Sócio", "qual":"Ultra Qualif. (+100k)",
      "qualBg":"#f5f3ff", "qualColor":"#7c3aed", "data":"16/07" }
  ],
  "creativesList": [
    { "rank":1, "rankBg":"#16a34a", "cardBg":"#f6fdf8", "cardBorder":"#bbf7d0",
      "tag":"ESCALAR", "tagBg":"#dcfce7", "tagColor":"#15803d",
      "nome":"Carrossel_Dores_v2", "camp":"[Q]_[CAPTACAO]_[ESCALA]",
      "cpl":"R$ 445,18", "cplq":"R$ 445,18", "cplqColor":"#16a34a",
      "qualif":"2", "invest":"R$ 890,36", "ctr":"0.88%", "leads":"2" }
  ],
  "updatedAt": "2026-07-18T13:00:00.000Z"
}
```
