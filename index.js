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
  console.log("Customer search raw response:", JSON.stringify(data));
  return data.records?.[0] || null;
}

async function findFittingByICalUID(iCalUID) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}?filterByFormula=${encodeURIComponent(`{iCal UID}="${iCalUID}"`)}`;
  const res = await fetch(url, { headers: AIRTABLE_HEADERS });
  const data = await res.json();
  // Return the original booking (iCalSequence 0) if multiple found
  const records = data.records || [];
  return records.find(r => r.fields["iCal Sequence"] === 0) || records[0] || null;
}

async function findFittingByUid(uid) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}?filterByFormula=${encodeURIComponent(`{Cal UID}="${uid}"`)}`;
  const res = await fetch(url, { headers: AIRTABLE_HEADERS });
  const data = await res.json();
  return data.records?.[0] || null;
}

app.get("/", (req, res) => res.json({ status: "Cal → Airtable webhook running" }));

app.post("/webhook", async (req, res) => {
  try {
    const event = req.body;
    const triggerEvent = event.triggerEvent;
    console.log("Received event:", triggerEvent);
    const payload = event.payload;

    // --- BOOKING CANCELLED ---
    if (triggerEvent === "BOOKING_CANCELLED") {
      console.log("Handling cancellation for UID:", payload.uid);
      const fitting = await findFittingByUid(payload.uid);
      if (fitting) {
        await airtableRequest("PATCH", AIRTABLE_TABLE_NAME, {
          fields: { "Status": "Cancelled" }
        }, fitting.id);
        console.log(`Marked fitting ${fitting.id} as Cancelled`);
      } else {
        console.log("No fitting found for UID:", payload.uid);
      }
      return res.status(200).json({ success: true });
    }

    // --- BOOKING RESCHEDULED ---
    if (triggerEvent === "BOOKING_RESCHEDULED") {
      console.log("Reschedule payload uid:", payload.uid, "rescheduleUid:", payload.rescheduleUid);
      const originalUid = payload.rescheduleUid || payload.uid;
      console.log("Handling reschedule, looking up original UID:", originalUid);
      const oldFitting = await findFittingByUid(originalUid);

      const attendee = payload.attendees?.[0] || {};
      const fullName = attendee.name || "";
      const nameParts = fullName.trim().split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";
      const customerEmail = attendee.email || "";
      const customerPhone =
        payload.responses?.attendeePhoneNumber?.value ||
        payload.responses?.phone?.value ||
        attendee.phoneNumber || "";
      const eventType = payload.type || payload.eventType?.title || "";
      const timezone = payload.organizer?.timeZone || attendee.timeZone || "America/Chicago";
      const startTime = payload.startTime ? new Date(payload.startTime) : null;
      const bookingDateUTC = payload.startTime || "";
      const bookingDateDisplay = startTime
        ? startTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: timezone })
          + " · "
          + startTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: timezone })
        : "";
      const location = payload.location || payload.videoCallData?.url || payload.responses?.location?.value || "";
    const organizer = payload.organizer?.name || "";
      const bookingNotes = payload.responses?.notes?.value || payload.responses?.message?.value || payload.additionalNotes || payload.description || "";
      const metadata = payload.metadata || {};
      const responses = payload.responses || {};
      const userFields = payload.userFieldsResponses || {};
      const getUtm = (key) => metadata[key] || userFields[key]?.value || responses[key]?.value || "";

      // Mark old fitting as Rescheduled
      if (oldFitting) {
        await airtableRequest("PATCH", AIRTABLE_TABLE_NAME, {
          fields: { "Status": "Rescheduled" }
        }, oldFitting.id);
        console.log("Marked fitting " + oldFitting.id + " as Rescheduled");
      }

      // Find customer to link
      let customerId = null;
      if (customerEmail) {
        const customer = await findCustomerByEmail(customerEmail);
        if (customer) customerId = customer.id;
      }

      // Create new fitting record
      const newFitting = await airtableRequest("POST", AIRTABLE_TABLE_NAME, {
        fields: {
          "Name": fullName,
          "Fitting Type": eventType,
          "Date": bookingDateDisplay,
          "Date (UTC)": bookingDateUTC,
          "Location": location,
          "Email": customerEmail,
          "Phone": customerPhone,
          "Notes": bookingNotes,
          "Status": "Scheduled",
          "Organizer": organizer,
      "Cal UID": payload.uid || "",
      "iCal UID": iCalUID,
      "iCal Sequence": iCalSequence,
          "UTM Source": getUtm("utm_source"),
          "UTM Medium": getUtm("utm_medium"),
          "UTM Campaign": getUtm("utm_campaign"),
          "UTM Term": getUtm("utm_term"),
          "UTM Content": getUtm("utm_content"),
        }
      });

      if (newFitting.error) {
        console.error("New fitting create error:", JSON.stringify(newFitting));
      } else {
        console.log("Created new fitting: " + newFitting.id);
        if (customerId) {
          await airtableRequest("PATCH", AIRTABLE_TABLE_NAME, {
            fields: { "Customer": [customerId] }
          }, newFitting.id);
        }
      }

      return res.status(200).json({ success: true });
    }

    // --- BOOKING CREATED ---
    if (triggerEvent !== "BOOKING_CREATED") {
      console.log(`Ignoring event type: ${triggerEvent}`);
      return res.status(200).json({ ignored: true });
    }

    // If rescheduleUid is present, this is actually a reschedule
    const rescheduleReason = payload.responses?.rescheduleReason?.value || "";
    const iCalSequence = payload.iCalSequence || 0;
    const iCalUID = payload.iCalUID || "";
    const isReschedule = !!rescheduleReason || iCalSequence > 0;
    console.log("Is reschedule:", isReschedule, "iCalUID:", iCalUID, "iCalSequence:", iCalSequence, "rescheduleReason:", rescheduleReason);

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
    console.log("Organizer timezone:", payload.organizer?.timeZone);
    console.log("Start time raw:", payload.startTime);

    const startTime = payload.startTime ? new Date(payload.startTime) : null;
    const timezone = payload.organizer?.timeZone || attendee.timeZone || "America/Chicago";
    const bookingDateUTC = payload.startTime || "";
    const bookingDateDisplay = startTime
      ? startTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: timezone })
        + " · "
        + startTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: timezone })
      : "";

    const location = payload.location || payload.videoCallData?.url || payload.responses?.location?.value || "";
    const organizer = payload.organizer?.name || "";
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

    // --- Step 2: If reschedule, mark old fitting as Rescheduled ---
    if (isReschedule) {
      const oldFitting = await findFittingByICalUID(iCalUID);
      if (oldFitting) {
        await airtableRequest("PATCH", AIRTABLE_TABLE_NAME, {
          fields: { "Status": "Rescheduled" }
        }, oldFitting.id);
        console.log("Marked old fitting as Rescheduled:", oldFitting.id);
      } else {
        console.log("Could not find old fitting with iCalUID:", iCalUID);
      }
    }

    // --- Step 3: Create fitting record ---
    const fittingFields = {
      "Name": fullName,
      "Fitting Type": eventType,
      "Date": bookingDateDisplay,
      "Date (UTC)": bookingDateUTC,
      "Location": location,
      "Email": customerEmail,
      "Phone": customerPhone,
      "Notes": bookingNotes,
      "Status": "Scheduled",
      "Organizer": organizer,
      "Cal UID": payload.uid || "",
      "iCal UID": iCalUID,
      "iCal Sequence": iCalSequence,
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

    // --- Step 3: Link customer to fitting ---
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
