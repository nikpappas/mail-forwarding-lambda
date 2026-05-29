# mail-forwarding-lambda
A lambda that stores incoming emails to a bucket and forwards them through ses


## Environment variables

MAIL_RECEIVING=<email you are receiving>
MAIL_TO_FORWARD=<email you are forwarding to>
STORAGE_BUCKET=<the s3 bucket you use for storage>
