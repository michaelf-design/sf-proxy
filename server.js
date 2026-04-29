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

    // Log what we're sending
    console.log('=== METADATA DEPLOY ===');
    console.log('Instance:', instanceUrl);
    console.log('Body length:', body.length);
    console.log('Body preview:', body.substring(0, 500));

    const response = await fetch(`${instanceUrl}/services/Soap/m/59.0`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '""' },
      body: body
    });

    const text = await response.text();

    // Log what Salesforce returned
    console.log('=== SF RESPONSE ===');
    console.log('Status:', response.status);
    console.log('Response preview:', text.substring(0, 1000));

    res.status(response.status).set('Content-Type', 'text/xml').send(text);
  } catch (e) {
    console.log('=== DEPLOY ERROR ===', e.message);
    res.status(500).send(`<error>${e.message}</error>`);
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', version: '3.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SF Proxy v3 running on port ${PORT}`));
