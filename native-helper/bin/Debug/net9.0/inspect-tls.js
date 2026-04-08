const https = require('https');

const hostname = process.argv[2];
if (!hostname) {
  process.stdout.write(JSON.stringify({ ok: false, certificates: null, error: 'Hostname is required.' }));
  process.exit(1);
}

function mapCert(cert) {
  return {
    subject: cert.subject || null,
    issuer: cert.issuer || null,
    rawDER: cert.raw ? cert.raw.toString('hex') : null,
    fingerprint: cert.fingerprint256 || cert.fingerprint || null,
  };
}

const req = https.get({
  host: hostname,
  servername: hostname,
  path: '/',
  method: 'GET',
  rejectUnauthorized: false,
}, (res) => {
  const chain = [];
  let current = res.socket.getPeerCertificate(true);

  while (current) {
    chain.push(mapCert(current));
    if (!current.issuerCertificate || current.issuerCertificate === current) {
      break;
    }
    current = current.issuerCertificate;
  }

  process.stdout.write(JSON.stringify({ ok: true, certificates: chain, error: null }));
  res.resume();
  res.on('end', () => process.exit(0));
});

req.on('error', (err) => {
  process.stdout.write(JSON.stringify({ ok: false, certificates: null, error: err.message }));
  process.exit(1);
});

req.setTimeout(10000, () => {
  process.stdout.write(JSON.stringify({ ok: false, certificates: null, error: 'Node TLS request timed out.' }));
  req.destroy();
  process.exit(1);
});
