// Template generator for notification emails.
// Every template returns an array of { to, subject, text, html } objects.
// User-supplied content is escaped when inserted into HTML bodies (D11).

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(isoStr) {
  if (!isoStr) return 'N/A';
  const d = new Date(isoStr);
  return isNaN(d.getTime()) ? String(isoStr) : d.toDateString();
}

function formatCurrency(amount) {
  if (amount == null) return '₹0';
  return `₹${Number(amount).toLocaleString('en-IN')}`;
}

const templates = {
  'booking.confirmed': (data) => {
    const {
      bookingId,
      guestEmail,
      guestName,
      hostEmail,
      hostName,
      listingTitle,
      checkIn,
      checkOut,
      guests,
      totalPrice,
    } = data;

    const formattedCheckIn = formatDate(checkIn);
    const formattedCheckOut = formatDate(checkOut);
    const formattedPrice = formatCurrency(totalPrice);

    const emails = [];

    // Email to Guest
    if (guestEmail) {
      emails.push({
        to: guestEmail,
        subject: `Your stay at ${listingTitle} is confirmed`,
        text: `Hi ${guestName || 'Guest'},\n\nYour booking for "${listingTitle}" is confirmed!\n\nCheck-in: ${formattedCheckIn}\nCheck-out: ${formattedCheckOut}\nGuests: ${guests}\nTotal: ${formattedPrice}\nBooking ID: ${bookingId}\n\nEnjoy your stay!\n— Wanderlust Team`,
        html: `
          <div style="font-family: sans-serif; line-height: 1.5; color: #333;">
            <h2>Your stay at ${escapeHtml(listingTitle)} is confirmed!</h2>
            <p>Hi ${escapeHtml(guestName || 'Guest')},</p>
            <p>Your booking has been confirmed with the following details:</p>
            <ul>
              <li><strong>Listing:</strong> ${escapeHtml(listingTitle)}</li>
              <li><strong>Check-in:</strong> ${escapeHtml(formattedCheckIn)}</li>
              <li><strong>Check-out:</strong> ${escapeHtml(formattedCheckOut)}</li>
              <li><strong>Guests:</strong> ${escapeHtml(String(guests))}</li>
              <li><strong>Total Price:</strong> ${escapeHtml(formattedPrice)}</li>
              <li><strong>Booking ID:</strong> ${escapeHtml(bookingId)}</li>
            </ul>
            <p>Enjoy your stay!<br><strong>Wanderlust Team</strong></p>
          </div>
        `,
      });
    }

    // Email to Host
    if (hostEmail) {
      emails.push({
        to: hostEmail,
        subject: `New booking for ${listingTitle}`,
        text: `Hi ${hostName || 'Host'},\n\nYou have a new booking for "${listingTitle}" by ${guestName || 'a guest'}.\n\nCheck-in: ${formattedCheckIn}\nCheck-out: ${formattedCheckOut}\nGuests: ${guests}\nTotal Payout: ${formattedPrice}\nBooking ID: ${bookingId}\n\n— Wanderlust Team`,
        html: `
          <div style="font-family: sans-serif; line-height: 1.5; color: #333;">
            <h2>New booking for ${escapeHtml(listingTitle)}</h2>
            <p>Hi ${escapeHtml(hostName || 'Host')},</p>
            <p>You have received a new booking from <strong>${escapeHtml(guestName || 'a guest')}</strong>.</p>
            <ul>
              <li><strong>Listing:</strong> ${escapeHtml(listingTitle)}</li>
              <li><strong>Check-in:</strong> ${escapeHtml(formattedCheckIn)}</li>
              <li><strong>Check-out:</strong> ${escapeHtml(formattedCheckOut)}</li>
              <li><strong>Guests:</strong> ${escapeHtml(String(guests))}</li>
              <li><strong>Total Payout:</strong> ${escapeHtml(formattedPrice)}</li>
              <li><strong>Booking ID:</strong> ${escapeHtml(bookingId)}</li>
            </ul>
            <p>— <strong>Wanderlust Team</strong></p>
          </div>
        `,
      });
    }

    return emails;
  },

  'booking.cancelled': (data) => {
    const {
      bookingId,
      guestEmail,
      guestName,
      hostEmail,
      listingTitle,
      checkIn,
      checkOut,
    } = data;

    const formattedCheckIn = formatDate(checkIn);
    const formattedCheckOut = formatDate(checkOut);
    const emails = [];

    // Email to Guest
    if (guestEmail) {
      emails.push({
        to: guestEmail,
        subject: `Your booking at ${listingTitle} was cancelled`,
        text: `Hi ${guestName || 'Guest'},\n\nYour booking for "${listingTitle}" (${formattedCheckIn} - ${formattedCheckOut}) has been cancelled.\nBooking ID: ${bookingId}\n\n— Wanderlust Team`,
        html: `
          <div style="font-family: sans-serif; line-height: 1.5; color: #333;">
            <h2>Booking Cancelled</h2>
            <p>Hi ${escapeHtml(guestName || 'Guest')},</p>
            <p>Your booking for <strong>${escapeHtml(listingTitle)}</strong> (${escapeHtml(formattedCheckIn)} - ${escapeHtml(formattedCheckOut)}) has been cancelled.</p>
            <p>Booking ID: ${escapeHtml(bookingId)}</p>
            <p>— <strong>Wanderlust Team</strong></p>
          </div>
        `,
      });
    }

    // Email to Host
    if (hostEmail) {
      emails.push({
        to: hostEmail,
        subject: `A booking for ${listingTitle} was cancelled`,
        text: `Hello,\n\nThe booking for "${listingTitle}" (${formattedCheckIn} - ${formattedCheckOut}) by ${guestName || 'the guest'} has been cancelled.\nBooking ID: ${bookingId}\n\n— Wanderlust Team`,
        html: `
          <div style="font-family: sans-serif; line-height: 1.5; color: #333;">
            <h2>Booking Cancelled</h2>
            <p>The booking for <strong>${escapeHtml(listingTitle)}</strong> (${escapeHtml(formattedCheckIn)} - ${escapeHtml(formattedCheckOut)}) by ${escapeHtml(guestName || 'the guest')} has been cancelled.</p>
            <p>Booking ID: ${escapeHtml(bookingId)}</p>
            <p>— <strong>Wanderlust Team</strong></p>
          </div>
        `,
      });
    }

    return emails;
  },

  'review.created': (data) => {
    const {
      hostEmail,
      hostName,
      listingTitle,
      reviewerName,
      rating,
      comment,
    } = data;

    const emails = [];

    if (hostEmail) {
      emails.push({
        to: hostEmail,
        subject: `New ${rating}★ review on ${listingTitle}`,
        text: `Hi ${hostName || 'Host'},\n\n${reviewerName || 'A guest'} left a ${rating}★ review on "${listingTitle}":\n\n"${comment}"\n\n— Wanderlust Team`,
        html: `
          <div style="font-family: sans-serif; line-height: 1.5; color: #333;">
            <h2>New ${escapeHtml(String(rating))}★ Review</h2>
            <p>Hi ${escapeHtml(hostName || 'Host')},</p>
            <p><strong>${escapeHtml(reviewerName || 'A guest')}</strong> left a <strong>${escapeHtml(String(rating))}★</strong> review on <strong>${escapeHtml(listingTitle)}</strong>:</p>
            <blockquote style="border-left: 3px solid #ff385c; padding-left: 12px; color: #555; margin: 16px 0;">
              "${escapeHtml(comment)}"
            </blockquote>
            <p>— <strong>Wanderlust Team</strong></p>
          </div>
        `,
      });
    }

    return emails;
  },
};

module.exports = templates;
