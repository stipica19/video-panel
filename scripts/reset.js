// Briše bazu i media. Traži --yes da ne bi otišlo slučajno.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

if (!process.argv.includes('--yes')) {
  console.log(`Ovo briše sve iz ${DATA_DIR} (baza, slike, objave).`);
  console.log('Ako si siguran: npm run reset -- --yes');
  process.exit(1);
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log('Obrisano. Sljedeći start pravi praznu bazu.');
