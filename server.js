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
    const response = await fetch(url, { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: method !== 'GET' ? JSON.stringify(req.body) : undefined });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Metadata API SOAP proxy
app.post('/metadata-deploy', async (req, res) => {
  try {
    const instanceUrl = req.headers['x-sf-instance'];
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const response = await fetch(`${instanceUrl}/services/Soap/m/59.0`, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '""' }, body });
    const text = await response.text();
    console.log('DEPLOY STATUS:', response.status, text.substring(0, 500));
    res.status(response.status).set('Content-Type', 'text/xml').send(text);
  } catch (e) { res.status(500).send(`<error>${e.message}</error>`); }
});

// Translation via REST Metadata API (PATCH)
// Uses /services/data/vXX.0/metadata/Translations/he
app.post('/translate-rest', async (req, res) => {
  try {
    const instanceUrl = req.headers['x-sf-instance'];
    const token = req.headers['x-sf-token'];
    const { entries } = req.body;
    // entries = [{objectName, fieldName, hebrewLabel}]

    console.log('=== TRANSLATE REST ===');
    console.log('Entries:', JSON.stringify(entries));

    // Build the metadata payload for REST API
    const customObjects = {};
    entries.forEach(e => {
      if (!customObjects[e.objectName]) customObjects[e.objectName] = [];
      customObjects[e.objectName].push({ name: e.fieldName, label: e.hebrewLabel });
    });

    const payload = {
      customObjects: Object.entries(customObjects).map(([name, fields]) => ({
        name,
        customFields: fields.map(f => ({ name: f.name, label: f.label }))
      }))
    };

    console.log('Payload:', JSON.stringify(payload));

    // Try REST Metadata API PATCH
    const url = `${instanceUrl}/services/data/v59.0/metadata/Translations/he`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    console.log('REST STATUS:', response.status);
    console.log('REST RESPONSE:', text.substring(0, 800));

    res.status(response.status).send(text);
  } catch (e) {
    console.log('TRANSLATE REST ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Translation via Tooling API - set field label directly on CustomField
app.post('/translate-tooling', async (req, res) => {
  try {
    const instanceUrl = req.headers['x-sf-instance'];
    const token = req.headers['x-sf-token'];
    const { objectName, fieldApiName, hebrewLabel } = req.body;

    console.log('=== TRANSLATE TOOLING ===');
    console.log('Object:', objectName, 'Field:', fieldApiName, 'Label:', hebrewLabel);

    // Step 1: Find the CustomFieldTranslation record or FieldDefinition
    // Query for the field's EntityDefinition and DurableId
    const query = `SELECT Id, DurableId, QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectName}' AND QualifiedApiName = '${fieldApiName}'`;
    const qRes = await fetch(`${instanceUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(query)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const qData = await qRes.json();
    console.log('Field query result:', JSON.stringify(qData).substring(0, 400));

    if (!qData.records || !qData.records.length) {
      return res.status(404).json({ error: `Field ${fieldApiName} not found on ${objectName}` });
    }

    const durableId = qData.records[0].DurableId;
    console.log('DurableId:', durableId);

    // Step 2: Try to find existing translation
    const tQuery = `SELECT Id FROM CustomFieldTranslation WHERE DeveloperName = '${durableId}' AND Language = 'he'`;
    const tRes = await fetch(`${instanceUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(tQuery)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const tData = await tRes.json();
    console.log('Translation query:', JSON.stringify(tData).substring(0, 400));

    res.json({
      success: true,
      durableId,
      fieldFound: true,
      translationRecords: tData.records || [],
      message: 'Field found. Use this durableId to set translation.'
    });

  } catch (e) {
    console.log('TRANSLATE TOOLING ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: '4.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SF Proxy v4 running on port ${PORT}`));
