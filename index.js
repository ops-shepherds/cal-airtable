require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "Bookings";

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
    const name = attendee.name || "";
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
      return (
        metadata[key] ||
        userFields[key]?.value ||
        responses[key]?.value ||
        ""
      );
    }

    const utmSource   = getUtm("utm_source");
    const utmMedium   = getUtm("utm_medium");
    const utmCampaign = getUtm("utm_campaign");
    const utmTerm     = getUtm("utm_term");
    const utmContent  = getUtm("utm_content");

    // Build Airtable record
    const airtableFields = {
      "Name": name,
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

    console.log("Writing to Airtable:", airtableFields);

    const airtableRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AIRTABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
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
