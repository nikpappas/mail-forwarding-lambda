"use strict";
import SES from '@aws-sdk/client-ses';
import S3 from '@aws-sdk/client-s3';

console.log("AWS Lambda SES Forwarder // @arithmetric // Version 4.2.0");

// Configure the S3 bucket and key prefix for stored raw emails, and the
// mapping of email addresses to forward from and to.
//
// Expected keys/values:
//
// - fromEmail: Forwarded emails will come from this verified address
//
// - subjectPrefix: Forwarded emails subject will contain this prefix
//
// - emailBucket: S3 bucket name where SES stores emails.
//
// - emailKeyPrefix: S3 key name prefix where SES stores email. Include the
//   trailing slash.
//
// - forwardMapping: Object where the key is the lowercase email address from
//   which to forward and the value is an array of email addresses to which to
//   send the message.
//
//   To match all email addresses on a domain, use a key without the name part
//   of an email address before the "at" symbol (i.e. `@example.com`).
//
//   To match a mailbox name on all domains, use a key without the "at" symbol
//   and domain part of an email address (i.e. `info`).
var defaultConfig = {
  fromEmail: "noreply@example.com",
  subjectPrefix: "",
  emailBucket: "s3-bucket-name",
  emailKeyPrefix: "emailsPrefix/",
  forwardMapping: {
    "info@example.com": [
      "example.john@example.com",
      "example.jen@example.com"
    ],
    "abuse@example.com": [
      "example.jim@example.com"
    ],
    "@example.com": [
      "example.john@example.com"
    ],
    "info": [
      "info@example.com"
    ]
  }
};

/**
 * Parses the SES event record provided for the `mail` and `receipients` data.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
function parseEvent(data) {
  // Validate characteristics of a SES event record.
  if (!data.event ||
    !data.event.hasOwnProperty('Records') ||
    data.event.Records.length !== 1 ||
    !data.event.Records[0].hasOwnProperty('eventSource') ||
    data.event.Records[0].eventSource !== 'aws:ses' ||
    data.event.Records[0].eventVersion !== '1.0') {
    data.log({
      message: "parseEvent() received invalid SES message:",
      level: "error", event: JSON.stringify(data.event)
    });
    throw new Error('Error: Received invalid SES message.');
  }

  data.email = data.event.Records[0].ses.mail;
  data.recipients = data.event.Records[0].ses.receipt.recipients;
  return data;
};

/**
 * Transforms the original recipients to the desired forwarded destinations.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
function transformRecipients(data) {
  var newRecipients = [];
  data.originalRecipients = data.recipients;
  data.recipients.forEach(function (origEmail) {
    var origEmailKey = origEmail.toLowerCase();
    if (data.config.forwardMapping.hasOwnProperty(origEmailKey)) {
      data.log({ level: 'info', message: "forward mapping has origEmailkey" + origEmailKey });
      newRecipients = newRecipients.concat(
        data.config.forwardMapping[origEmailKey]);
      data.originalRecipient = origEmail;
    } else {
      data.log({ level: 'info', message: "figuring out origEmailKey:" + origEmailKey });
      var origEmailDomain;
      var origEmailUser;
      var pos = origEmailKey.lastIndexOf("@");
      if (pos === -1) {
        origEmailUser = origEmailKey;
        data.log({ level: 'info', message: "origEmailUser=" + origEmailKey });
      } else {
        origEmailDomain = origEmailKey.slice(pos);
        origEmailUser = origEmailKey.slice(0, pos);
        data.log({ level: 'info', message: "origEmailUser=" + origEmailUser });
        data.log({ level: 'info', message: "origEmailDomain=" + origEmailDomain });
      }
      if (origEmailDomain &&
        data.config.forwardMapping.hasOwnProperty(origEmailDomain)) {
        newRecipients = newRecipients.concat(
          data.config.forwardMapping[origEmailDomain]);
        data.originalRecipient = origEmail;
      } else if (origEmailUser &&
        data.config.forwardMapping.hasOwnProperty(origEmailUser)) {
        newRecipients = newRecipients.concat(
          data.config.forwardMapping[origEmailUser]);
        data.originalRecipient = origEmail;
      }
    }
  });

  if (!newRecipients.length) {
    data.log({
      message: "Finishing process. No new recipients found for " +
        "original destinations: " + data.originalRecipients.join(", "),
      level: "info"
    });
    return data.callback();
  }

  data.recipients = newRecipients;
  return data;
};

/**
 * Fetches the message data from S3.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
async function fetchMessage(data) {
  // Copying email object to ensure read permission
  data.log({
    level: "info", message: "Fetching email at s3://" +
      data.config.emailBucket + '/' + data.config.emailKeyPrefix +
      data.email.messageId
  });
  const result = await data.s3.send(new S3.GetObjectCommand({
    Bucket: data.config.emailBucket,
    Key: data.config.emailKeyPrefix + data.email.messageId
  }));
  if (result.$metadata.httpStatusCode != 200) {
    data.log({
      level: "error", message: "getObject() returned error:" + result.$metadata.httpStatusCode,
    });
    throw new Error("Error: Failed to load message body from S3.");
  }
  return await result.Body.transformToString();

};

/**
 * Processes the message data, making updates to recipients and other headers
 * before forwarding message.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
function processMessage(data) {

  var match = data.emailData.match(/^((?:.+\r?\n)*)(\r?\n(?:.*\s+)*)/m);
  var header = match && match[1] ? match[1] : data.emailData;
  var body = match && match[2] ? match[2] : '';

  // Add "Reply-To:" with the "From" address if it doesn't already exists
  if (!/^Reply-To: /mi.test(header)) {
    match = header.match(/^From: (.*(?:\r?\n\s+.*)*\r?\n)/m);
    var from = match && match[1] ? match[1] : '';
    if (from) {
      header = header + 'Reply-To: ' + from;
      data.log({ level: "info", message: "Added Reply-To address of: " + from });
    } else {
      data.log({
        level: "info", message: "Reply-To address not added because " +
          "From address was not properly extracted."
      });
    }
  }

  // SES does not allow sending messages from an unverified address,
  // so replace the message's "From:" header with the original
  // recipient (which is a verified domain)
  header = header.replace(
    /^From: (.*(?:\r?\n\s+.*)*)/mg,
    function (match, from) {
      var fromText;
      if (data.config.fromEmail) {
        fromText = 'From: ' + from.replace(/<(.*)>/, '').trim() +
          ' <' + data.config.fromEmail + '>';
      } else {
        fromText = 'From: ' + from.replace('<', 'at ').replace('>', '') +
          ' <' + data.originalRecipient + '>';
      }
      return fromText;
    });

  // Add a prefix to the Subject
  if (data.config.subjectPrefix) {
    header = header.replace(
      /^Subject: (.*)/mg,
      function (match, subject) {
        return 'Subject: ' + data.config.subjectPrefix + subject;
      });
  }

  // Replace original 'To' header with a manually defined one
  if (data.config.toEmail) {
    header = header.replace(/^To: (.*)/mg, () => 'To: ' + data.config.toEmail);
  }

  // Remove the Return-Path header.
  header = header.replace(/^Return-Path: (.*)\r?\n/mg, '');

  // Remove Sender header.
  header = header.replace(/^Sender: (.*)\r?\n/mg, '');

  // Remove Message-ID header.
  header = header.replace(/^Message-ID: (.*)\r?\n/mig, '');

  // Remove all DKIM-Signature headers to prevent triggering an
  // "InvalidParameterValue: Duplicate header 'DKIM-Signature'" error.
  // These signatures will likely be invalid anyways, since the From
  // header was modified.
  header = header.replace(/^DKIM-Signature: .*\r?\n(\s+.*\r?\n)*/mg, '');

  data.emailData = header + body;
  return data;
};

/**
 * Send email using the SES sendRawEmail command.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
async function sendMessage(data) {
  var enc = new TextEncoder(); // always utf-8

  var params = {
    Destinations: data.recipients,
    Source: data.originalRecipient,
    RawMessage: {
      Data: enc.encode(data.emailData)
      // Data: Buffer.from(data.emailData)
    }
  };
  data.log({
    level: "info", message: "sendMessage: Sending email via SES. " +
      "Original recipients: " + data.originalRecipients.join(", ") +
      ". Transformed recipients: " + data.recipients.join(", ") + "."
  });
  const sendRes = await data.ses.send(new SES.SendRawEmailCommand(params));
  data.log({
    level: "info", message: "sendRawEmail().",
    result: sendRes
  });
  if (sendRes.$metadata.httpStatusCode == 200) {
    data.log({
      level: "info", message: "sendRawEmail() successful.",
    });
  } else {
    throw new Error('Error: Email sending failed.');
  }
  return data
}


/**
 * Handler function to be invoked by AWS Lambda with an inbound SES email as
 * the event.
 *
 * @param {object} event - Lambda event from inbound email received by AWS SES.
 * @param {object} context - Lambda context object.
 * @param {object} overrides - Overrides for the default data, including the
 * configuration, SES object, and S3 object.
 */
export const handlerImpl = async (event, context, overrides) => {

  var data = {
    event: event,
    context: context,
    config: overrides && overrides.config ? overrides.config : defaultConfig,
    log: overrides && overrides.log ? overrides.log : console.log,
    ses: overrides && overrides.ses ? overrides.ses : new SES.SESClient(),
    s3: overrides && overrides.s3 ?
      overrides.s3 : new S3.S3Client({ signatureVersion: 'v4' })
  };

  parseEvent(data);
  transformRecipients(data);
  const fetchRes = await fetchMessage(data);
  data.emailData = fetchRes;
  processMessage(data);
  await sendMessage(data);
  return {
    statusCode: 200,
    body: 'Email processed successfully'
  };

};
