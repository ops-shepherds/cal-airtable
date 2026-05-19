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

// --- Airtable helpers ---

async function findCustomerByEmail(email) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_CUSTOMERS_TABLE)}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}`;
  const res = await fetch(url, { headers: AIRTABLE_HEADERS });
  const data = await res.json();
  return data.records?.[0] || null;
}

async function createCustomer(fields) {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_CUSTOMERS_TABLE)}`,
    {
      method: "POST",
      headers: AIRTABLE_HEADERS,
      body: JSON.stringify({ fields }),
    }
  );
  return res.json();
}

async function updateCustomer(recordId, fields) {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_CUSTOMERS_TABLE)}/${recordId}`,
    {
      method: "PATCH",
      headers: AIRTABLE_HEADERS,
      body: JSON.stringify({ fields }),
    }
  );
  return res.json();
}

// Health check
app.get("/", (req, res) => res.json({ status: "Cal → Airtable webhook running" }));

app.post("/webhook", async (req, res) => {
  try {
    const event = req.body;

    if (event.triggerEvent !== "BOOKING_CREATED") {
      console.log(`Ignoring event type: ${event.triggerEvent}`);
      return res.status(200).json({ ignored: true });
    }

    const payload = event.payload;

    // Attendee
    const attendee = payload.attendees?.[0] || {};
    const fullName = attendee.name || "";
    const nameParts = fullName.trim().split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";
    const customerEmail = attendee.email || "";

    // Phone
    const customerPhone =
      payload.responses?.attendeePhoneNumber?.value ||
      payload.responses?.phone?.value ||
      attendee.phoneNumber ||
      "";

    // Event type slug (internal name)
    const eventType =
      payload.type ||
      payload.eventType?.title ||
      "";

    // Booking date & time
    const startTime = payload.startTime ? new Date(payload.startTime) : null;
    const bookingDate = startTime ? startTime.toISOString().split("T")[0] : "";
    const bookingTime = startTime
      ? startTime.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: attendee.timeZone || "UTC",
        })
      : "";

    // Location
    const location =
      payload.location ||
      payload.videoCallData?.url ||
      payload.responses?.location?.value ||
      "";

    // Notes
    const bookingNotes =
      payload.responses?.notes?.value ||
      payload.responses?.message?.value ||
      payload.additionalNotes ||
      payload.description ||
      "";

    // UTM parameters — check metadata, responses, and userFieldsResponses
    const metadata = payload.metadata || {};
    const responses = payload.responses || {};
    const userFields = payload.userFieldsResponses || {};

    function getUtm(key) {
      return metadata[key] || userFields[key]?.value || responses[key]?.value || "";
    }

    const utmSource   = getUtm("utm_source");
    const utmMedium   = getUtm("utm_medium");
    const utmCampaign = getUtm("utm_campaign");
    const utmTerm     = getUtm("utm_term");
    const utmContent  = getUtm("utm_content");

    // --- Find or create customer ---
    let customerId = null;

    if (customerEmail) {
      let customer = await findCustomerByEmail(customerEmail);

      if (customer) {
        console.log(`Found existing customer: ${customer.id}`);
        customerId = customer.id;
        // Update phone if missing
        if (!customer.fields["Phone"] && customerPhone) {
          await updateCustomer(customer.id, { "Phone": customerPhone });
        }
      } else {
        console.log(`Customer not found, creating new record for ${customerEmail}`);
        const newCustomer = await createCustomer({
          "First Name": firstName,
          "Last Name": lastName,
          "Email": customerEmail,
          "Phone": customerPhone,
        });
        if (newCustomer.error) {
          console.error("Failed to create customer:", JSON.stringify(newCustomer));
        }
        customerId = newCustomer.id;
        console.log(`Created new customer: ${customerId}`);
      }
    }

    // --- Build Airtable fitting record ---
    const airtableFields = {
      "Name": fullName,
      "Fitting Type": eventType,
      "Date": bookingDate ? `${bookingDate} ${bookingTime}`.trim() : "",
      "Location": location,
      "Email": customerEmail,
      "Phone": customerPhone,
      "Notes": bookingNotes,
      "UTM Source": utmSource,
      "UTM Medium": utmMedium,
      "UTM Campaign": utmCampaign,
      "UTM Term": utmTerm,
      "UTM Content": utmContent,
    };

    // Link to customer if found/created
    if (customerId) {
      airtableFields["Customer"] = [{ "id": customerId }];
    }

    console.log("Writing to Airtable:", airtableFields);

    const airtableRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`,
      {
        method: "POST",
        headers: AIRTABLE_HEADERS,
        body: JSON.stringify({ fields: airtableFields }),
      }
    );

    const airtableData = await airtableRes.json();

    if (!airtableRes.ok) {
      console.error("Airtable error:", airtableData);
      return res.status(500).json({ error: "Airtable write failed", detail: airtableData });
    }

    console.log("Record created:", airtableData.id);
    res.status(200).json({ success: true, airtableId: airtableData.id });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
