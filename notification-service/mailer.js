const nodemailer = require('nodemailer');

async function createMailer() {
  let transporter;
  let isEthereal = false;

  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          }
        : undefined,
    });
    console.log(`Mailer initialized with SMTP host: ${process.env.SMTP_HOST}`);
  } else {
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
    isEthereal = true;
    console.log(`Mailer initialized with Ethereal test account: ${testAccount.user}`);
  }

  const fromAddress = process.env.EMAIL_FROM || 'Wanderlust <no-reply@wanderlust.test>';

  return {
    isEthereal,
    async send({ to, subject, text, html }) {
      const info = await transporter.sendMail({
        from: fromAddress,
        to,
        subject,
        text,
        html,
      });

      const previewUrl = nodemailer.getTestMessageUrl(info);
      return previewUrl || null;
    },
  };
}

module.exports = { createMailer };
