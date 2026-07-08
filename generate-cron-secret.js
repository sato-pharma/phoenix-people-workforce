// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('crypto');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
const secret = 'phx_cron_' + crypto.randomBytes(24).toString('hex');
let envYaml = fs.readFileSync('env.yaml', 'utf8');
envYaml = envYaml.replace(/CRON_SECRET: ""/, 'CRON_SECRET: "' + secret + '"');
fs.writeFileSync('env.yaml', envYaml);
let script = fs.readFileSync('scripts/setup-gcp-cron.sh', 'utf8');
script = script.replace(/CRON_SECRET=""/, 'CRON_SECRET="' + secret + '"');
fs.writeFileSync('scripts/setup-gcp-cron.sh', script);
console.log('Generated CRON_SECRET:', secret);
