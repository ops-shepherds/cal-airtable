require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "Fittings";
const AIRTABLE_CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE || "Customers";

const AIRTABLE_HEADERS = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
  "Content-Type": "application/json",
};

async function airtableRequest(method, table, body, recordId) {
  const url = recordId
    ? `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`
    : `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
  const res = await fetch(url, { method, headers: AIRTABLE_HEADERS, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

async function findCustomerByEmail(email) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_CUSTOMERS_TABLE)}?filterByFormula=${encodeURIComponent(`LOWER({Email})=LOWER("${email}")`)}`;
  const res = await fetch(url, { headers: AIRTABLE_HEADERS });
  const data = await res.json();
  console.log("Customer search for", email, "returned:", JSON.stringify(data.records?.map(r => r.fields?.Email)));
  return data.records?.[0] || null;
}

app.get("/", (req, res) => res.json({ status: "Cal → Airtable webhook running" }));

app.post("/webhook", async (req, res) => {
  try {
    const event = req.body;

    if (event.triggerEvent !== "BOOKING_CREATED") {
      console.log(`Ignoring event type: ${event.triggerEvent}`);
      return res.status(200).json({ ignored: true });
    }

    const payload = event.payload;
    const attendee = payload.attendees?.[0] || {};
    const fullName = attendee.name || "";
    const nameParts = fullName.trim().split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";
    const customerEmail = attendee.email || "";

    const customerPhone =
      payload.responses?.attendeePhoneNumber?.value ||
      payload.responses?.phone?.value ||
      attendee.phoneNumber ||
      "";

    const eventType = payload.type || payload.eventType?.title || "";

    const startTime = payload.startTime ? new Date(payload.startTime) : null;
    const bookingDate = startTime ? startTime.toISOString().split("T")[0] : "";
    const bookingTime = startTime
      ? startTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: attendee.timeZone || "UTC" })
      : "";

    const location = payload.location || payload.videoCallData?.url || payload.responses?.location?.value || "";
    const bookingNotes = payload.responses?.notes?.value || payload.responses?.message?.value || payload.additionalNotes || payload.description || "";

    const metadata = payload.metadata || {};
    const responses = payload.responses || {};
    const userFields = payload.userFieldsResponses || {};
    const getUtm = (key) => metadata[key] || userFields[key]?.value || responses[key]?.value || "";

    // --- Step 1: Find or create customer ---
    let customerId = null;
    if (customerEmail) {
      let customer = await findCustomerByEmail(customerEmail);
      if (customer) {
        customerId = customer.id;
        console.log(`Found existing customer: ${customerId}`);
        if (!customer.fields["Phone"] && customerPhone) {
          await airtableRequest("PATCH", AIRTABLE_CUSTOMERS_TABLE, { fields: { "Phone": customerPhone } }, customerId);
        }
      } else {
        console.log(`Creating new customer for ${customerEmail}`);
        const newCustomer = await airtableRequest("POST", AIRTABLE_CUSTOMERS_TABLE, {
          fields: {
            "First Name": firstName,
            "Last Name": lastName,
            "Email": customerEmail,
            "Phone": customerPhone,
          }
        });
        if (newCustomer.error) {
          console.error("Failed to create customer:", JSON.stringify(newCustomer));
        } else {
          customerId = newCustomer.id;
          console.log(`Created new customer: ${customerId}`);
        }
      }
    }

    // --- Step 2: Create fitting record WITHOUT customer link ---
    const fittingFields = {
      "Name": fullName,
      "Fitting Type": eventType,
      "Date": bookingDate ? `${bookingDate} ${bookingTime}`.trim() : "",
      "Location": location,
      "Email": customerEmail,
      "Phone": customerPhone,
      "Notes": bookingNotes,
      "UTM Source": getUtm("utm_source"),
      "UTM Medium": getUtm("utm_medium"),
      "UTM Campaign": getUtm("utm_campaign"),
      "UTM Term": getUtm("utm_term"),
      "UTM Content": getUtm("utm_content"),
    };

    console.log("Creating fitting record...");
    const fitting = await airtableRequest("POST", AIRTABLE_TABLE_NAME, { fields: fittingFields });

    if (fitting.error) {
      console.error("Fitting create error:", JSON.stringify(fitting));
      return res.status(500).json({ error: "Fitting create failed", detail: fitting });
    }

    console.log(`Fitting created: ${fitting.id}`);

    // --- Step 3: Link customer to fitting in a separate PATCH call ---
    if (customerId && fitting.id) {
      console.log(`Linking customer ${customerId} to fitting ${fitting.id}`);
      const linkResult = await airtableRequest("PATCH", AIRTABLE_TABLE_NAME, {
        fields: { "Customer": [customerId] }
      }, fitting.id);

      if (linkResult.error) {
        console.error("Link error:", JSON.stringify(linkResult));
      } else {
        console.log("Customer linked successfully");
      }
    }

    res.status(200).json({ success: true, airtableId: fitting.id });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
