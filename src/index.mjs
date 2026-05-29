
import { handlerImpl } from "./mail-forwarder.mjs"


export const handler = async (event, context) => {
  // See aws-lambda-ses-forwarder/index.js for all options.
  var overrides = {
    config: {
      fromEmail: process.env.MAIL_RECEIVING,
      emailBucket: process.env.STORAGE_BUCKET,
      emailKeyPrefix: process.env.STORAGE_KEY_PREFIX,
      forwardMapping: {
        [process.env.MAIL_RECEIVING]: [
          process.env.MAIL_TO_FORWARD
        ]
      }
    }
  };
  return await handlerImpl(event, context, overrides);
};