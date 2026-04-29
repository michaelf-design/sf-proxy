const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.text({ type: '*/*', limit: '50mb' }));

// OAuth Username-Password Flow
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

// General Salesforce REST API proxy
app.post('/api', async (req, res) => {
  try {
    const url = req.headers['x-sf-url'];
    const token = req.headers['x-sf-token'];
    const method = req.headers['x-sf-method'] || 'POST';
    const response = await fetch(url, {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: method !== 'GET' ? JSON.stringify(req.body) : undefined
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Metadata API SOAP proxy
app.post('/metadata-deploy', async (req, res) => {
  try {
    const instanceUrl = req.headers['x-sf-instance'];
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const response = await fetch(`${instanceUrl}/services/Soap/m/59.0`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '""' },
      body
    });
    const text = await response.text();
    res.status(response.status).set('Content-Type', 'text/xml').send(text);
  } catch (e) { res.status(500).send(`<error>${e.message}</error>`); }
});

// Diagnose what translation APIs are available
app.post('/translate-diagnose', async (req, res) => {
  try {
    const instanceUrl = req.headers['x-sf-instance'];
    const token = req.headers['x-sf-token'];
    const { objectName, fieldApiName } = req.body;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const results = {};

    // Test 1: FieldDefinition query
    try {
      const q = `SELECT Id, DurableId, QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName='${objectName}' AND QualifiedApiName='${fieldApiName}'`;
      const r = await fetch(`${instanceUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(q)}`, { headers });
      const d = await r.json();
      results.fieldDefinition = { status: r.status, records: d.records || [], error: d[0]?.message };
      console.log('FieldDefinition:', JSON.stringify(results.fieldDefinition).substring(0,400));
    } catch(e) { results.fieldDefinition = { error: e.message }; }

    // Test 2: Check if CustomFieldTranslation is queryable
    try {
      const r = await fetch(`${instanceUrl}/services/data/v59.0/tooling/sobjects/CustomFieldTranslation/`, { headers });
      const d = await r.json();
      results.customFieldTranslation = { status: r.status, available: r.status === 200, data: JSON.stringify(d).substring(0,200) };
      console.log('CustomFieldTranslation:', JSON.stringify(results.customFieldTranslation).substring(0,400));
    } catch(e) { results.customFieldTranslation = { error: e.message }; }

    // Test 3: Check Translations via standard REST
    try {
      const r = await fetch(`${instanceUrl}/services/data/v59.0/metadata/Translations/`, { headers });
      const d = await r.text();
      results.restMetadata = { status: r.status, data: d.substring(0,200) };
      console.log('REST Metadata:', JSON.stringify(results.restMetadata).substring(0,400));
    } catch(e) { results.restMetadata = { error: e.message }; }

    // Test 4: Try Tooling API describe for translation objects
    try {
      const r = await fetch(`${instanceUrl}/services/data/v59.0/tooling/sobjects/`, { headers });
      const d = await r.json();
      const translationObjs = (d.sobjects || []).filter(s => s.name.toLowerCase().includes('translat'));
      results.translationObjects = translationObjs.map(s => s.name);
      console.log('Translation objects available:', results.translationObjects);
    } catch(e) { results.translationObjects = { error: e.message }; }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Translation via Tooling API CustomFieldTranslation
app.post('/translate-tooling', async (req, res) => {
  try {
    const instanceUrl = req.headers['x-sf-instance'];
    const token = req.headers['x-sf-token'];
    const { objectName, fieldApiName, hebrewLabel } = req.body;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    console.log('=== TRANSLATE TOOLING ===');
    console.log('Object:', objectName, 'Field:', fieldApiName, 'Label:', hebrewLabel);

    // Step 1: Get field DurableId
    const fieldQuery = `SELECT Id, DurableId, QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName='${objectName}' AND QualifiedApiName='${fieldApiName}'`;
    const fRes = await fetch(`${instanceUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(fieldQuery)}`, { headers });
    const fData = await fRes.json();
    console.log('Field query status:', fRes.status);
    console.log('Field query result:', JSON.stringify(fData).substring(0, 500));

    if (!fData.records || !fData.records.length) {
      return res.status(404).json({ success: false, error: `Field ${fieldApiName} not found on ${objectName}. Status: ${fRes.status}. Response: ${JSON.stringify(fData).substring(0,200)}` });
    }

    const fieldDurableId = fData.records[0].DurableId;
    console.log('DurableId:', fieldDurableId);

    // Step 2: Check existing translation
    const tQuery = `SELECT Id FROM CustomFieldTranslation WHERE FieldDefinitionId='${fieldDurableId}' AND Language='he'`;
    const tRes = await fetch(`${instanceUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(tQuery)}`, { headers });
    const tData = await tRes.json();
    console.log('Translation query status:', tRes.status, JSON.stringify(tData).substring(0,300));

    if (tData.records && tData.records.length > 0) {
      const tid = tData.records[0].Id;
      const uRes = await fetch(`${instanceUrl}/services/data/v59.0/tooling/sobjects/CustomFieldTranslation/${tid}`, {
        method: 'PATCH', headers, body: JSON.stringify({ Label: hebrewLabel })
      });
      console.log('PATCH status:', uRes.status);
      res.json({ success: uRes.status === 204 || uRes.status === 200, status: uRes.status, action: 'updated' });
    } else {
      const cRes = await fetch(`${instanceUrl}/services/data/v59.0/tooling/sobjects/CustomFieldTranslation/`, {
        method: 'POST', headers, body: JSON.stringify({ FieldDefinitionId: fieldDurableId, Language: 'he', Label: hebrewLabel })
      });
      const cData = await cRes.json();
      console.log('POST status:', cRes.status, JSON.stringify(cData).substring(0,300));
      res.json({ success: cRes.status === 201 || cData.success === true, status: cRes.status, action: 'created', body: cData });
    }
  } catch (e) {
    console.log('TRANSLATE TOOLING ERROR:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: '6.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SF Proxy v6 running on port ${PORT}`));
