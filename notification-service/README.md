# Notification Microservice

A standalone background service that consumes email notification jobs from a BullMQ queue backed by Redis and sends formatted emails via Nodemailer (Ethereal test inbox by default, or custom SMTP).

## Job Contract

All jobs are **self-contained** and carry all information necessary to build and send the email. The notification service **never connects to the main database**.

| Job Name | Payload |
|---|---|
| `booking.confirmed` | `{ bookingId, guestEmail, guestName, hostEmail, hostName, listingTitle, checkIn, checkOut, guests, totalPrice }` |
| `booking.cancelled` | `{ bookingId, guestEmail, guestName, hostEmail, listingTitle, checkIn, checkOut }` |
| `review.created` | `{ reviewId, hostEmail, hostName, listingTitle, reviewerName, rating, comment }` |

*Note: Dates (`checkIn`, `checkOut`) are formatted as ISO 8601 strings.*

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection URL for BullMQ |
| `SMTP_HOST` | *(unset)* | Host for real SMTP server (if unset, Ethereal test inbox is used) |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_USER` | *(unset)* | SMTP username |
| `SMTP_PASS` | *(unset)* | SMTP password |
| `SMTP_SECURE` | `false` | Set to `true` for TLS (port 465) |
| `EMAIL_FROM` | `Wanderlust <no-reply@wanderlust.test>` | Sender address |
| `FAIL_RATE` | `0` | Probability (0.0 to 1.0) of simulated failure for testing retries |

## Running Locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the worker:
   ```bash
   npm start
   ```

## Running with Docker

The service is integrated into the root `docker-compose.yml`:
```bash
docker compose up --build -d notification
```
