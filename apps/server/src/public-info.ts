import type { FastifyInstance, FastifyReply } from 'fastify';

function page(title: string, body: string): string {
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} – Browser Screenshot</title><style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#171717}
main{border:1px solid #ddd;border-radius:16px;padding:28px}h1{margin-top:0}h2{margin-top:28px}p,li{line-height:1.55}
nav{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px}a{color:#175cd3}.muted{color:#666}
@media(max-width:600px){body{margin:20px auto;padding:0 14px}main{padding:20px}}
</style></head><body><nav><a href="/">Browser Screenshot</a><a href="/about">Om tjänsten</a><a href="/support">Support</a><a href="/privacy">Integritet</a><a href="/terms">Villkor</a></nav><main>${body}</main></body></html>`;
}

export async function registerPublicInfo(app: FastifyInstance): Promise<void> {
  const send = (reply: FastifyReply, title: string, body: string) =>
    reply.type('text/html; charset=utf-8').header('cache-control','public, max-age=300').send(page(title, body));

  app.get('/about', async (_request, reply) => send(reply, 'Om tjänsten', `
<h1>Browser Screenshot</h1>
<p>Browser Screenshot öppnar en publik HTTP(S)-webbsida i en isolerad Chromium-browser och returnerar en PNG-skärmdump.</p>
<h2>Så fungerar det</h2><ul>
<li>Användaren anger en publik webbadress.</li>
<li>Tjänsten renderar sidan med vald desktop-, tablet-, mobil- eller egen viewport.</li>
<li>Resultatet returneras som PNG tillsammans med teknisk metadata.</li>
<li>Tjänsten är avgränsad till visuell fångst och är inte ett generellt browser-automationsverktyg.</li>
</ul>
<p>Utvecklare: Erland Lindmark. <a href="https://github.com/erland/browser-screenshot">Källkod på GitHub</a>.</p>`));

  app.get('/support', async (_request, reply) => send(reply, 'Support', `
<h1>Support för Browser Screenshot</h1>
<p>Felrapporter, frågor och förbättringsförslag kan lämnas i projektets publika GitHub Issues.</p>
<p><a href="https://github.com/erland/browser-screenshot/issues">Öppna GitHub Issues</a></p>
<p>Publicera inte OAuth-tokens, sessionscookies, interna URL:er eller andra hemligheter i ett issue.</p>`));

  app.get('/privacy', async (_request, reply) => send(reply, 'Integritet', `
<h1>Integritetspolicy för Browser Screenshot</h1>
<p>Browser Screenshot behandlar de uppgifter som behövs för autentisering, screenshot-fångst och säker drift.</p>
<h2>Uppgifter som behandlas</h2><ul>
<li>GitHub-identitet och uppgifter som behövs för autentisering och allowlist-kontroll.</li>
<li>Publika URL:er och screenshot-inställningar som användaren skickar till tjänsten.</li>
<li>Genererade PNG-bilder och teknisk metadata under själva förfrågan.</li>
<li>Tekniska drift-, säkerhets- och revisionsloggar. Hemligheter ska inte avsiktligt loggas.</li>
</ul>
<h2>Användning och lagring</h2>
<p>Uppgifterna används för att rendera den begärda publika sidan, skapa skärmdumpen, tillämpa säkerhetsgränser och returnera resultatet. Tjänsten är inte avsedd att lagra en permanent historik över skärmdumpar.</p>
<h2>Tredje parter</h2>
<p>GitHub används för autentisering. Browser Screenshot säljer inte personuppgifter och använder inte skärmdumpar eller URL:er för annonsering.</p>
<p>Frågor om databehandling kan tas via <a href="/support">support-sidan</a>.</p>
<p class="muted">Senast uppdaterad: 7 oktober 2026.</p>`));

  app.get('/terms', async (_request, reply) => send(reply, 'Villkor', `
<h1>Användarvillkor för Browser Screenshot</h1>
<p>Genom att använda Browser Screenshot ansvarar du för att du har rätt att öppna och visuellt fånga den webbsida du anger.</p>
<h2>Ditt ansvar</h2><ul>
<li>Använd endast publika HTTP(S)-adresser som du har rätt att använda.</li>
<li>Använd inte tjänsten för att försöka nå localhost, privata nätverk eller andra icke-publika resurser.</li>
<li>Använd inte tjänsten för olaglig verksamhet eller för att kringgå åtkomstkontroller.</li>
</ul>
<h2>Tjänstens omfattning</h2>
<p>Browser Screenshot fångar bilder. Den loggar inte in, klickar, skickar formulär eller ändrar den besökta webbplatsen.</p>
<p>Support finns på <a href="/support">support-sidan</a>.</p>
<p class="muted">Senast uppdaterad: 7 oktober 2026.</p>`));
}
