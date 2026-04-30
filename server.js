const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.text({ type: '*/*', limit: '50mb' }));

app.post('/soap-login', async (req, res) => {
  try {
    const env = req.headers['x-sf-env'] || 'https://login.salesforce.com';
    const { username, password, clientId, clientSecret } = req.body;
    const params = new URLSearchParams({ grant_type: 'password', client_id: clientId, client_secret: clientSecret, username, password });
    const response = await fetch(`${env}/services/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    const data = await response.json();
    if (data.access_token) {
      res.json({ success: true, sessionId: data.access_token, instanceUrl: data.instance_url, orgId: data.id?.split('/')[4] || '', userId: data.id?.split('/')[5] || '' });
    } else {
      res.status(400).json({ success: false, error: data.error_description || data.error });
    }
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api', async (req, res) => {
  try {
    const url = req.headers['x-sf-url'];
    const token = req.headers['x-sf-token'];
    const method = req.headers['x-sf-method'] || 'POST';
    const response = await fetch(url, { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: method !== 'GET' ? JSON.stringify(req.body) : undefined });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/metadata-deploy', async (req, res) => {
  try {
    const instanceUrl = req.headers['x-sf-instance'];
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const response = await fetch(`${instanceUrl}/services/Soap/m/59.0`, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '""' }, body });
    const text = await response.text();
    res.status(response.status).set('Content-Type', 'text/xml').send(text);
  } catch (e) { res.status(500).send(`<error>${e.message}</error>`); }
});

// Read current translation then update it via SOAP readMetadata/updateMetadata
app.post('/translate-metadata', async (req, res) => {
  try {
    const instanceUrl = req.headers['x-sf-instance'];
    const token = req.headers['x-sf-token'];
    const { entries } = req.body;
    // entries = [{objectName, fieldName (no __c), hebrewLabel}]

    console.log('=== TRANSLATE METADATA ===');
    console.log('Entries:', JSON.stringify(entries));

    // Step 1: readMetadata to get current 'he' translation
    const readSOAP = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:SessionHeader><met:sessionId>${token}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:readMetadata>
      <met:type>Translations</met:type>
      <met:fullNames>he</met:fullNames>
    </met:readMetadata>
  </soapenv:Body>
</soapenv:Envelope>`;

    console.log('Reading existing he translation...');
    const readRes = await fetch(`${instanceUrl}/services/Soap/m/59.0`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '""' },
      body: readSOAP
    });
    const readText = await readRes.text();
    console.log('Read status:', readRes.status);
    console.log('Read response:', readText.substring(0, 1000));

    // Step 2: Build updateMetadata SOAP with new fields added
    // Build customObjects sections for each entry
    const byObj = {};
    entries.forEach(e => {
      if (!byObj[e.objectName]) byObj[e.objectName] = [];
      byObj[e.objectName].push(e);
    });

    let customObjectsXML = '';
    Object.entries(byObj).forEach(([objName, fields]) => {
      customObjectsXML += `<met:customObjects>
          <met:name>${objName}</met:name>
          ${fields.map(f => `<met:customFields>
            <met:name>${f.fieldName}</met:name>
            <met:label>${f.hebrewLabel}</met:label>
          </met:customFields>`).join('\n          ')}
        </met:customObjects>`;
    });

    const updateSOAP = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:SessionHeader><met:sessionId>${token}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:updateMetadata>
      <met:metadata xsi:type="met:Translations" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <met:fullName>he</met:fullName>
        ${customObjectsXML}
      </met:metadata>
    </met:updateMetadata>
  </soapenv:Body>
</soapenv:Envelope>`;

    console.log('Sending updateMetadata...');
    console.log('Update SOAP:', updateSOAP.substring(0, 800));

    const updateRes = await fetch(`${instanceUrl}/services/Soap/m/59.0`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '""' },
      body: updateSOAP
    });
    const updateText = await updateRes.text();
    console.log('Update status:', updateRes.status);
    console.log('Update response:', updateText.substring(0, 1000));

    const success = updateText.includes('<success>true</success>');
    const error = updateText.match(/<faultstring>(.*?)<\/faultstring>/)?.[1] ||
                  updateText.match(/<message>(.*?)<\/message>/)?.[1] || '';

    res.json({ success, status: updateRes.status, error, readStatus: readRes.status });
  } catch (e) {
    console.log('TRANSLATE METADATA ERROR:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: '7.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SF Proxy v7 running on port ${PORT}`));
