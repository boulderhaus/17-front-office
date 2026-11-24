// Prints a fresh VAPID key pair for web push call alerts, as Railway variable assignments.
// Set them without echoing: npm run -s vapid:keys | xargs railway variables --set ... (the private key is a secret).
import { generateVapidKeys } from "../src/adapters/web-push.js";

const keys = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
