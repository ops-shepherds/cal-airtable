# Cal.com → Airtable Webhook

Receives Cal.com booking events and writes them as records in your Airtable CRM.

## Fields written to Airtable

| Airtable Field     | Source in Cal.com payload              |
|--------------------|----------------------------------------|
| Name               | attendees[0].name                      |
| Event Type         | eventType.title                        |
| Booking Date       | startTime (date portion)               |
| Booking Time       | startTime (time portion)               |
| Booking Location   | location / videoCallData.url           |
| Customer Email     | attendees[0].email                     |
| Customer Phone     | responses.phone.value                  |
| Booking Notes      | responses.notes / description          |
| UTM Parameters     | metadata.utm_source/medium/campaign... |

---

## Setup

### 1. Airtable — create your table fields

In your Airtable base, create a table (default name: `Bookings`) with these fields:

| Field Name         | Field Type     |
|--------------------|---------------|
| Name               | Single line text |
| Event Type         | Single line text |
| Booking Date       | Date           |
| Booking Time       | Single line text |
| Booking Location   | Single line text |
| Customer Email     | Email          |
| Customer Phone     | Phone number   |
| Booking Notes      | Long text      |
| UTM Parameters     | Single line text |

### 2. Get your Airtable credentials

- **API Key**: Go to https://airtable.com/create/tokens → create a Personal Access Token with `data.records:write` scope on your base
- **Base ID**: Open your base in Airtable → Help → API docs → the base ID starts with `app...`

### 3. Configure environment variables

```bash
cp .env.example .env
# Fill in your values
```

### 4. Install & run locally

```bash
npm install
node index.js
```

### 5. Deploy to the internet

**Railway (recommended — free tier available):**
1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add your env vars in the Railway dashboard
4. Railway gives you a public URL like `https://your-app.up.railway.app`

**Render:**
1. Push to GitHub
2. render.com → New Web Service → connect repo
3. Add env vars, deploy

**Vercel (serverless):**
Rename `index.js` to `api/webhook.js` and export the express app — see Vercel docs for Express adapter.

### 6. Register the webhook in Cal.com

1. Go to **Cal.com → Settings → Developer → Webhooks**
2. Click **New Webhook**
3. Set the URL to: `https://your-deployed-url.com/webhook`
4. Select trigger: **BOOKING_CREATED**
5. Optionally add a secret (copy it into your `CAL_WEBHOOK_SECRET` env var)
6. Save

### 7. Test it

Book a test meeting in Cal.com — within seconds a new record should appear in Airtable.

---

## Extending this

- **Handle reschedules**: Add a case for `BOOKING_RESCHEDULED` — update the existing record by searching for the booking UID
- **Handle cancellations**: Add `BOOKING_CANCELLED` — update a Status field in Airtable
- **Add a Status field**: Default to "New" on every booking so you can track CRM stage
- **Deduplication**: Cal.com sends `payload.uid` — store it in Airtable and check before inserting to avoid duplicates
