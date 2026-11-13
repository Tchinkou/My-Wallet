// Test de bout en bout (Playwright) : node tests/e2e.cjs [url]
// Lancez d'abord un serveur statique : python3 -m http.server 8080
const { chromium } = require('playwright');
const URL = process.argv[2] || 'http://localhost:8080/';
const SHOTS = process.env.SHOTS || null;
const PIN = '135792';
const norm = (s) => s.replace(/[\s  ]/g, '');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: true, hasTouch: true,
    acceptDownloads: true, locale: 'fr-FR',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const outside = [];
  page.on('request', (r) => { if (!r.url().startsWith(URL) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) outside.push(r.url()); });
  const shot = async (name) => {
    if (!SHOTS) return;
    for (let i = 0; i < 3; i++) {
      try { await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled', timeout: 8000 }); return; } catch { await page.waitForTimeout(300); }
    }
  };
  const check = (label, cond) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) process.exitCode = 1; };
  const val = async (id) => norm(await page.locator(`[data-testid="${id}"]`).innerText());
  const netVal = async () => {
    await page.goto(URL + '#accounts');
    await page.waitForSelector('[data-testid=net]');
    const btn = page.locator('[data-action="reveal-savings"]');
    if (await btn.count() && (await btn.innerText()).includes('Afficher')) await btn.click();
    const v = norm(await page.locator('[data-testid=net]').innerText());
    await page.goto(URL + '#home');
    await page.waitForSelector('[data-testid=spendable]');
    return v;
  };
  const typePin = async (pin) => { for (const d of pin) await page.click(`.key[data-k="${d}"]`); await page.click('.key[data-k="ok"]'); };

  await page.goto(URL);
  await page.waitForSelector('#start');
  await shot('01-accueil');
  await page.click('#start');
  await typePin(PIN);
  await page.waitForSelector('text=Confirmez le code');
  await typePin(PIN);
  await page.waitForSelector('#setup');
  await page.fill('input[name=cash]', '50000');
  await shot('02-initialisation');
  await page.click('#setup button[type=submit]');
  await page.waitForSelector('[data-testid=spendable]', { timeout: 20000 });
  check('Initialisation : disponible 50 000', (await val('spendable')) === '50000DA');

  const sheetForm = '.sheet-form form';
  async function addOp(type, fill) {
    await page.click(`.quick [data-type="${type}"], [data-action="add-menu"]`.split(',')[type === 'expense' || type === 'income' || type === 'loan' || type === 'repay' ? 0 : 1]);
    if (!['expense', 'income', 'loan', 'repay'].includes(type)) {
      await page.click(`.add-grid [data-type="${type}"]`);
    }
    await page.waitForSelector(sheetForm);
    await fill();
    await page.click(`${sheetForm} [data-submit]`);
    await page.waitForSelector('.sheet-form', { state: 'detached' });
    await page.waitForTimeout(150);
  }

  await addOp('expense', async () => {
    await page.fill(`${sheetForm} input[name=amount]`, '5000');
    await page.click('.cat:has-text("Alimentation")');
  });
  await addOp('income', async () => {
    await page.fill(`${sheetForm} input[name=amount]`, '20000');
    await page.click('.cat:has-text("Salaire")');
  });
  await addOp('loan', async () => {
    await page.fill(`${sheetForm} input[name=amount]`, '10000');
    await page.fill(`${sheetForm} input[name=person]`, 'Ahmed');
  });
  await addOp('repay', async () => {
    await page.fill(`${sheetForm} input[name=amount]`, '3000');
  });
  await addOp('debt', async () => {
    await page.fill(`${sheetForm} input[name=amount]`, '15000');
    await page.fill(`${sheetForm} input[name=person]`, 'Karim');
  });
  await addOp('repay', async () => {
    await page.click(`${sheetForm} [data-dir] [data-v="debt_repay"]`);
    await page.fill(`${sheetForm} input[name=amount]`, '5000');
  });

  check('Disponible = 53 000', (await val('spendable')) === '53000DA');
  check('Créances = 7 000', (await val('receivables')) === '7000DA');
  check('Dettes = 10 000', (await val('debts')) === '10000DA');
  check('Patrimoine net = 50 000', (await netVal()) === '50000DA');
  await shot('03-tableau-de-bord');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/04-tableau-de-bord-complet.png`, fullPage: true, animations: 'disabled' }).catch(() => {});

  // Personnes
  await page.goto(URL + '#people');
  await page.waitForSelector('.person-row');
  check('Ahmed doit 7 000', norm(await page.locator('.person-row:has-text("Ahmed") .op-amt').innerText()) === '7000DA');
  await page.click('.person-row:has-text("Ahmed")');
  await page.waitForSelector('.loan-card');
  check('Statut Ahmed : Partiellement remboursé', (await page.locator('.loan-card .status').innerText()).includes('Partiellement'));
  await shot('05-personne');
  await page.click('.sheet [data-close]');
  await page.click('[data-tab="debt"]');
  check('Karim : 10 000 à rembourser', norm(await page.locator('.person-row:has-text("Karim") .op-amt').innerText()) === '10000DA');

  // Historique : modifier la dépense 5000 -> 8000
  await page.goto(URL + '#history');
  await page.waitForSelector('.op-row');
  check('Historique : 6 opérations', (await page.locator('.op-row').count()) === 6);
  await shot('06-historique');
  await page.fill('#q', 'karim');
  await page.waitForTimeout(300);
  check('Recherche « karim » : 2 résultats', (await page.locator('.op-row').count()) === 2);
  await page.fill('#q', '');
  await page.waitForTimeout(300);
  await page.click('.op-row:has-text("Alimentation")');
  await page.click('.sheet [data-edit]');
  await page.fill(`${sheetForm} input[name=amount]`, '8000');
  await page.click(`${sheetForm} [data-submit]`);
  await page.waitForSelector('.sheet-form', { state: 'detached' });
  await page.goto(URL + '#home');
  await page.waitForSelector('[data-testid=spendable]');
  check('Après modification dépense 8 000 : disponible 50 000', (await val('spendable')) === '50000DA');
  check('Après modification : net 47 000', (await netVal()) === '47000DA');

  // Supprimer le remboursement d'Ahmed
  await page.goto(URL + '#history');
  await page.click('.op-row:has-text("Remboursement de Ahmed")');
  await page.click('.sheet [data-del]');
  await page.click('.sheet [data-yes]');
  await page.waitForTimeout(300);
  await page.goto(URL + '#home');
  await page.waitForSelector('[data-testid=spendable]');
  check('Après suppression remboursement : disponible 47 000', (await val('spendable')) === '47000DA');
  check('Après suppression remboursement : créances 10 000', (await val('receivables')) === '10000DA');
  check('Après suppression remboursement : net 47 000', (await netVal()) === '47000DA');

  // Supprimer le prêt d'Ahmed -> cascade
  await page.goto(URL + '#history');
  await page.click('.op-row:has-text("Prêt à Ahmed")');
  await page.click('.sheet [data-del]');
  await page.click('.sheet [data-yes]');
  await page.waitForTimeout(300);
  await page.goto(URL + '#home');
  await page.waitForSelector('[data-testid=spendable]');
  check('Après suppression prêt : disponible 57 000, créances 0', (await val('spendable')) === '57000DA' && (await val('receivables')) === '0DA');
  // Annulation (undo) disponible dans le toast : on teste via nouvelle suppression + annuler
  await page.goto(URL + '#history');
  await page.click('.op-row:has-text("Alimentation")');
  await page.click('.sheet [data-del]');
  await page.click('.sheet [data-yes]');
  await page.click('.toast button:has-text("Annuler")');
  await page.waitForTimeout(300);
  check('Annulation de suppression : 4 opérations', (await page.locator('.op-row').count()) === 4);

  // Remboursement trop élevé refusé
  await page.goto(URL + '#home');
  await page.click('.quick [data-type="repay"]');
  await page.click(`${sheetForm} [data-dir] [data-v="debt_repay"]`);
  await page.fill(`${sheetForm} input[name=amount]`, '99999');
  await page.click(`${sheetForm} [data-submit]`);
  check('Remboursement supérieur au reste dû refusé', (await page.locator('.sheet [data-err]').innerText()).includes('dépasse'));
  await page.click('.sheet [data-close]');
  await page.waitForTimeout(300);

  // Données chiffrées dans IndexedDB
  const raw = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('mywallet');
    r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('vault'); g.onsuccess = () => res(JSON.stringify(g.result)); };
  }));
  check('Coffre IndexedDB chiffré (aucun nom en clair)', !/Karim|Alimentation|50000/.test(raw) && raw.includes('"ct"'));

  // Verrouillage / déverrouillage
  await page.click('[data-action="lock"]');
  await page.waitForSelector('.screen-lock');
  check('Verrouillage : données effacées de l’écran', (await page.locator('[data-testid=spendable]').count()) === 0);
  await typePin('000000');
  await page.waitForSelector('.pin-sub.err');
  check('Mauvais PIN refusé', (await page.locator('.pin-sub').innerText()).includes('incorrect'));
  await shot('07-verrouillage');
  await typePin(PIN);
  await page.waitForSelector('[data-testid=spendable]', { timeout: 20000 });
  check('Déverrouillage : données retrouvées', (await val('spendable')) === '57000DA');

  // Masquage
  await page.click('[data-action="toggle-mask"]');
  await page.waitForTimeout(200);
  check('Mode discrétion : montants masqués', (await page.locator('[data-testid=spendable]').innerText()).includes('•'));
  await page.click('[data-action="toggle-mask"]');

  // Sauvegarde puis restauration
  await page.goto(URL + '#backup');
  await page.click('[data-action="export-backup"]');
  await page.fill('input[name=p1]', 'motdepasse-test');
  await page.fill('input[name=p2]', 'motdepasse-test');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.sheet button[type=submit]')]);
  const file = await download.path();
  const content = require('fs').readFileSync(file, 'utf8');
  check('Sauvegarde chiffrée (pas de données en clair)', content.includes('mywallet-backup') && !/Karim/.test(content));
  // Ajout d'une dépense puis restauration -> doit revenir à l'état sauvegardé
  await page.goto(URL + '#home');
  await addOp('expense', async () => { await page.fill(`${sheetForm} input[name=amount]`, '1000'); await page.click('.cat:has-text("Transport")'); });
  check('Avant restauration : 56 000', (await val('spendable')) === '56000DA');
  await page.goto(URL + '#backup');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-action="import-backup"]')]);
  await chooser.setFiles(file);
  await page.fill('input[name=p1]', 'mauvais');
  await page.click('.sheet button[type=submit]');
  await page.waitForSelector('.toast-error');
  check('Mauvais mot de passe de sauvegarde refusé', (await page.locator('.toast-error').first().innerText()).includes('incorrect'));
  const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-action="import-backup"]')]);
  await chooser2.setFiles(file);
  await page.fill('input[name=p1]', 'motdepasse-test');
  await page.click('.sheet button[type=submit]');
  await page.waitForSelector('.sheet [data-yes]', { timeout: 20000 });
  await page.click('.sheet [data-yes]');
  await page.waitForSelector('[data-testid=spendable]');
  check('Restauration : 57 000', (await val('spendable')) === '57000DA');

  // CSV
  await page.goto(URL + '#backup');
  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export-csv"]')]);
  const csvText = require('fs').readFileSync(await csv.path(), 'utf8');
  check('Export CSV (en-tête + 4 lignes)', csvText.split('\r\n').length === 5 && csvText.includes('Date;Type;Montant'));

  // Correction d'un prêt saisi dans le mauvais sens : conversion en dette
  await page.goto(URL + '#home');
  await addOp('loan', async () => {
    await page.fill(`${sheetForm} input[name=amount]`, '2000');
    await page.fill(`${sheetForm} input[name=person]`, 'Erreur');
  });
  check('Prêt erroné : créances 2 000, utilisable 55 000', (await val('receivables')) === '2000DA' && (await val('spendable')) === '55000DA');
  await page.goto(URL + '#people');
  await page.click('[data-action="people-tab"][data-tab="loan"]');
  await page.click('.person-row:has-text("Erreur")');
  await page.click('.sheet [data-action="convert-loan"]');
  await page.waitForSelector(sheetForm);
  await page.click(`${sheetForm} [data-submit]`);
  await page.waitForSelector('.sheet-form', { state: 'detached' });
  await page.goto(URL + '#home');
  await page.waitForSelector('[data-testid=spendable]');
  check('Après conversion : créances 0, dettes 12 000, utilisable 57 000',
    (await val('receivables')) === '0DA' && (await val('debts')) === '12000DA' && (await val('spendable')) === '57000DA');
  // Suppression directe depuis la fiche personne
  await page.goto(URL + '#people');
  await page.click('[data-action="people-tab"][data-tab="debt"]');
  await page.click('.person-row:has-text("Erreur")');
  await page.click('.sheet [data-action="delete-op"]');
  await page.click('.sheet [data-yes]');
  await page.waitForTimeout(300);
  await page.goto(URL + '#home');
  await page.waitForSelector('[data-testid=spendable]');
  check('Suppression depuis la fiche personne : dettes 10 000', (await val('debts')) === '10000DA');

  // Section Euro (montants en dinars, liés au portefeuille)
  const tv = async (id) => norm(await page.locator(`[data-testid=${id}]`).innerText());
  const spendableNow = async () => { await page.goto(URL + '#home'); await page.waitForSelector('[data-testid=spendable]'); return val('spendable'); };
  const confirmPay = async () => { await page.click('[data-action="euro-done"]'); await page.click('.sheet [data-submit]'); await page.waitForTimeout(300); };
  await page.goto(URL + '#euro');
  await page.waitForSelector('[data-testid=euro-total-receive]');
  await page.click('[data-action="euro-form"][data-kind="receive"]');
  await page.fill('.sheet input[name=amount]', '40000');
  await page.fill('.sheet input[name=client]', 'Client A');
  await page.click('.sheet [data-submit]');
  await page.waitForTimeout(300);
  check('Euro : client qui me doit 40 000 DA en attente', (await tv('euro-total-receive')) === '40000DA');
  check('Euro : en attente, utilisable inchangé (57 000)', (await spendableNow()) === '57000DA');
  check('Tableau de bord : carte Euro en dinars', (await tv('euro-receive')) === '40000DA' && (await page.locator('[data-testid=net]').count()) === 0);
  await page.goto(URL + '#euro');
  await confirmPay();
  check('Euro : « client m\u2019a payé » ajoute 40 000 (97 000)', (await spendableNow()) === '97000DA');
  await page.goto(URL + '#euro');
  await page.click('[data-action="euro-tab"][data-tab="pay"]');
  await page.click('[data-action="euro-form"][data-kind="pay"]');
  await page.fill('.sheet input[name=amount]', '25000');
  await page.fill('.sheet input[name=client]', 'Fournisseur B');
  await page.click('.sheet [data-submit]');
  await page.waitForTimeout(300);
  check('Euro : client à payer en attente, utilisable inchangé (97 000)', (await spendableNow()) === '97000DA');
  await page.goto(URL + '#euro');
  await page.click('[data-action="euro-tab"][data-tab="pay"]');
  await confirmPay();
  await shot('12-euro');
  check('Euro : « client payé » retire 25 000 (72 000)', (await spendableNow()) === '72000DA');
  await shot('13-tableau-de-bord-v12');
  await page.goto(URL + '#history');
  check('Historique : paiements Euro visibles', (await page.locator('.op-row:has-text("Paiement de Client A")').count()) === 1
    && (await page.locator('.op-row:has-text("Paiement à Fournisseur B")').count()) === 1);
  await page.goto(URL + '#euro');
  await page.click('[data-action="euro-tab"][data-tab="pay"]');
  await page.click('[data-action="euro-settled"]');
  await page.click('[data-action="euro-undo"]');
  await page.click('.sheet [data-yes]');
  await page.waitForTimeout(300);
  check('Euro : annulation du paiement (97 000, 25 000 à payer)', (await tv('euro-total-pay')) === '25000DA' && (await spendableNow()) === '97000DA');
  // remise à l'état attendu par la suite du test (57 000)
  await page.goto(URL + '#euro');
  await page.click('[data-action="euro-tab"][data-tab="receive"]');
  await page.click('[data-action="euro-undo"]');
  await page.click('.sheet [data-yes]');
  await page.waitForTimeout(300);
  check('Euro : tout annulé, utilisable revenu à 57 000', (await spendableNow()) === '57000DA');

  // Pages restantes (rendu sans erreur)
  for (const r of ['accounts', 'settings', 'security', 'install', 'categories']) {
    await page.goto(URL + '#' + r);
    await page.waitForTimeout(400);
    await shot(`08-${r}`);
  }
  await page.goto(URL + '#home');
  await page.click('[data-action="add-menu"]');
  await page.waitForTimeout(400);
  await shot('09-ajouter');
  await page.click('.add-grid [data-type="expense"]');
  await page.waitForTimeout(400);
  await shot('10-formulaire-depense');
  await page.click('.sheet [data-close]');

  // Hors ligne
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 }).catch(() => {});
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.screen-lock', { timeout: 10000 });
  await typePin(PIN);
  await page.waitForSelector('[data-testid=spendable]', { timeout: 20000 });
  check('Hors ligne : application et données disponibles', (await val('spendable')) === '57000DA');
  await ctx.setOffline(false);

  // Thème clair
  await page.goto(URL + '#settings');
  await page.click('[data-action="theme"][data-v="light"]');
  await page.goto(URL + '#home');
  await page.waitForTimeout(300);
  await shot('11-theme-clair');

  check('Aucune erreur JavaScript', errors.length === 0);
  if (errors.length) console.log(errors);
  check('Aucune requête vers un tiers', outside.length === 0);
  if (outside.length) console.log(outside);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
