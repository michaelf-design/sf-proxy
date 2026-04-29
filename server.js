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

// Hebrew translation via Tooling API CustomFieldTranslation
app.post('/translate-tooling', async (req, res) => {
  try {
    const instanceUrl = req.headers['x-sf-instance'];
    const token = req.headers['x-sf-token'];
    const { objectName, fieldApiName, hebrewLabel } = req.body;

    console.log('=== TRANSLATE TOOLING ===');
    console.log('Object:', objectName, 'Field:', fieldApiName, 'Label:', hebrewLabel);

    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Step 1: Get the field's EntityDefinitionId and DurableId
    const fieldQuery = `SELECT Id, DurableId, QualifiedApiName, EntityDefinitionId FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectName}' AND QualifiedApiName = '${fieldApiName}'`;
    const fRes = await fetch(`${instanceUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(fieldQuery)}`, { headers });
    const fData = await fRes.json();
    console.log('Field query:', JSON.stringify(fData).substring(0, 500));

    if (!fData.records || !fData.records.length) {
      return res.status(404).json({ success: false, error: `Field ${fieldApiName} not found on ${objectName}` });
    }

    const fieldDurableId = fData.records[0].DurableId;
    console.log('Field DurableId:', fieldDurableId);

    // Step 2: Check if translation already exists
    const tQuery = `SELECT Id FROM CustomFieldTranslation WHERE FieldDefinitionId = '${fieldDurableId}' AND Language = 'he'`;
    const tRes = await fetch(`${instanceUrl}/services/data/v59.0/tooling/query?q=${encodeURIComponent(tQuery)}`, { headers });
    const tData = await tRes.json();
    console.log('Existing translation:', JSON.stringify(tData).substring(0, 400));

    let result;
    if (tData.records && tData.records.length > 0) {
      // Update existing translation
      const tid = tData.records[0].Id;
      console.log('Updating existing translation ID:', tid);
      const uRes = await fetch(`${instanceUrl}/services/data/v59.0/tooling/sobjects/CustomFieldTranslation/${tid}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ Label: hebrewLabel })
      });
      const uText = uRes.status === 204 ? 'updated' : await uRes.text();
      console.log('Update result:', uRes.status, uText);
      result = { success: uRes.status === 204 || uRes.status === 200, status: uRes.status, action: 'updated', body: uText };
    } else {
      // Create new translation
      console.log('Creating new translation');
      const cRes = await fetch(`${instanceUrl}/services/data/v59.0/tooling/sobjects/CustomFieldTranslation/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ FieldDefinitionId: fieldDurableId, Language: 'he', Label: hebrewLabel })
      });
      const cData = await cRes.json();
      console.log('Create result:', cRes.status, JSON.stringify(cData));
      result = { success: cRes.status === 201 || cData.success, status: cRes.status, action: 'created', body: cData };
    }

    res.json(result);
  } catch (e) {
    console.log('TRANSLATE TOOLING ERROR:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: '5.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SF Proxy v5 running on port ${PORT}`));
