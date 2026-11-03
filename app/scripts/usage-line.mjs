import { readUsageFile, usageLine } from '../server/usage-count.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run usage -- <file>');
  process.exitCode = 2;
} else {
  try {
    const totals = readUsageFile(file);
    if (totals === null) {
      console.error(`no usage file at ${file}`);
      process.exitCode = 1;
    } else console.log(usageLine(totals));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
