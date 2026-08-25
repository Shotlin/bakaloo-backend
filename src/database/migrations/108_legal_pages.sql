-- 108_legal_pages.sql
--
-- Makes Terms & Conditions, Privacy Policy, and About Us dashboard-editable.
-- Previously these three pages were hardcoded HTML/JSX directly in
-- bakaloo-customer-web (src/app/terms, /privacy, /about) — any change
-- required a code deploy. This table becomes the single source of truth;
-- the website fetches and renders it, and the customer app already links
-- out to the website for these pages (in-app WebView), so no app release
-- is needed for either the initial cutover or any future edit.
--
-- Seeded with the exact current page content so the cutover changes
-- nothing for site visitors until an admin actually edits something.

CREATE TABLE IF NOT EXISTS legal_pages (
  slug         VARCHAR(40) PRIMARY KEY,
  title        VARCHAR(200) NOT NULL,
  content_html TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   UUID REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO legal_pages (slug, title, content_html) VALUES
('terms', 'Terms & Conditions', '<p class="meta">Last updated: July 5, 2026</p>
<p>These terms govern your use of the Bakaloo app and website (the &quot;Service&quot;), operated by Bakaloo And Foods Enterprise (&quot;Bakaloo&quot;, &quot;we&quot;, &quot;us&quot;). By creating an account or placing an order, you agree to these terms.</p>
<h2>1. About Bakaloo</h2>
<p>Bakaloo is a multi-vendor grocery delivery platform. Orders are fulfilled by independent shops listed on the platform and delivered by delivery riders. Bakaloo facilitates the order, payment, and delivery process between you and the fulfilling shop.</p>
<h2>2. Your Account</h2>
<ul>
<li>You must provide a valid phone number and verify it via OTP to create an account.</li>
<li>You''re responsible for keeping your account and device secure.</li>
<li>You must be at least 18 years old to place an order (certain restricted items may require additional age verification at delivery).</li>
</ul>
<h2>3. Orders &amp; Pricing</h2>
<ul>
<li>Product prices, availability, and delivery fees are shown at checkout before you pay and may vary by shop, distance, and demand.</li>
<li>An order is confirmed once payment succeeds (online) or is accepted by the shop (Cash on Delivery, where available).</li>
<li>You can cancel an order free of charge until the shop begins packing it; after that, cancellation may not be possible or may be subject to the shop''s policy.</li>
<li>Applicable taxes (including GST, where charged) are shown as a separate line in your bill before you pay.</li>
</ul>
<h2>4. Payments</h2>
<p>Payments are processed through Razorpay. By paying, you also agree to Razorpay''s applicable terms. Refunds for cancelled or undeliverable orders are issued to your original payment method or Bakaloo wallet, per our refund policy shown at the time of cancellation.</p>
<h2>5. Delivery</h2>
<p>Delivery times shown in the app are estimates, not guarantees, and can be affected by weather, traffic, or shop readiness. You''re responsible for providing an accurate delivery address and being reachable at delivery time.</p>
<h2>6. Returns &amp; Refunds</h2>
<p>Given the perishable nature of most items sold, most products are not eligible for return once delivered, except where an item arrives damaged, incorrect, or missing — report this from your order within the window shown in the app so we can arrange a refund or replacement.</p>
<h2>7. Wallet</h2>
<p>The Bakaloo Wallet is a closed-loop stored-value balance. You can add money to it (via Razorpay) and use it to pay for orders. Sending balance to another Bakaloo user is built into the Service but currently turned off; if enabled in future, it will be subject to minimum and maximum transfer limits and biometric (or passcode) confirmation on your device. The Wallet is not a bank account, is not interest-bearing, cannot be withdrawn as cash or transferred to a bank account/UPI, and a remaining balance is not automatically refunded if you delete your account — contact us first to arrange a refund (see our <a href="/account-deletion">Account Deletion</a> page).</p>
<h2>8. Acceptable Use</h2>
<p>You agree not to misuse the Service — including submitting false information, abusing promotional offers, or interfering with delivery riders or shop staff. We may suspend or terminate accounts that violate these terms.</p>
<h2>9. Limitation of Liability</h2>
<p>Bakaloo facilitates orders between you and independent shops/riders and is not liable for indirect or consequential losses arising from delays, unavailability of items, or actions of a shop or rider, beyond the value of the affected order, except where required by applicable law.</p>
<h2>10. Changes to These Terms</h2>
<p>We may update these terms as the Service evolves. Continued use after a change means you accept the updated terms.</p>
<h2>11. Governing Law</h2>
<p>These terms are governed by the laws of India. See our <a href="/privacy">Privacy Policy</a> for how we handle your data.</p>
<h2>12. Contact Us</h2>
<p>Questions about these terms? Reach us at <a href="mailto:support@bakaloo.in">support@bakaloo.in</a> or call our helpline at <a href="tel:+919924998906">+91 99249 98906</a>.</p>'),

('privacy', 'Privacy Policy', '<p class="meta">Last updated: August 1, 2026</p>
<p>Bakaloo And Foods Enterprise (&quot;Bakaloo&quot;, &quot;we&quot;, &quot;us&quot;, &quot;our&quot;) operates the Bakaloo mobile app and website (together, the &quot;Service&quot;), a grocery delivery platform. This policy explains what information we collect, why we collect it, and how it is handled. It applies to everyone who uses the Service — customers, and where noted, shop staff and delivery riders.</p>
<h2>1. Information We Collect</h2>
<h3>Information you give us</h3>
<ul>
<li>Your name and phone number, used to create your account and verify it via a one-time password (OTP).</li>
<li>Delivery addresses, including the precise map location you pin, so orders can be delivered accurately.</li>
<li>Order details — items, quantities, delivery instructions, and any notes you add.</li>
<li>Reviews, ratings, and support messages you choose to submit.</li>
<li>Wallet transactions and transfers you make within the app (see &quot;Bakaloo Wallet&quot; below).</li>
</ul>
<h3>Bakaloo Wallet</h3>
<p>The Bakaloo Wallet is a stored-value balance you can top up (via Razorpay) and use to pay for orders. It is a closed-loop balance: it can only be spent within Bakaloo — it cannot be withdrawn to a bank account, UPI, or cash. Sending balance to another Bakaloo user is built into the app but currently turned off; if we turn it back on, it will require you to confirm with your device''s fingerprint/face unlock or passcode, and we will update this policy first.</p>
<h3>Information collected automatically</h3>
<ul>
<li><strong>Location:</strong> with your permission, we use your device''s location to suggest a delivery address, calculate delivery distance and fees, and show live order tracking. You can decline location access — you''ll be asked to enter your address manually instead.</li>
<li><strong>Push notification token:</strong> to send order status updates and, if you allow it, promotional notifications.</li>
<li><strong>Microphone (voice search):</strong> if you tap the microphone icon in Search, we briefly access your device''s microphone to convert your spoken words into a text search query. Audio is processed by your device''s operating system (Apple Speech on iOS, Google speech recognition on Android) — Bakaloo does not receive, store, or listen to the raw audio, only the resulting text, which is then used exactly like a typed search. You can decline microphone access and use typed search instead.</li>
<li><strong>App usage and diagnostics:</strong> we use Firebase Analytics and Firebase Crashlytics (both operated by Google) to understand how the app is used and to detect and fix crashes. This includes device type, app version, and in-app actions such as viewing a product or starting checkout — it does not include the content of your orders or payments.</li>
</ul>
<h3>Information we do not collect</h3>
<p>We do not access your camera, photo library, contacts, SMS messages, or call logs. Where the app uses biometric unlock (fingerprint/face) to confirm a wallet transfer, that check is performed entirely on your device by the operating system — your biometric data is never sent to us or stored on our servers.</p>
<h2>2. Payments</h2>
<p>Card, UPI, netbanking, and wallet payments are processed by Razorpay, a licensed payment gateway. Bakaloo does not receive or store your full card number, CVV, or UPI PIN — Razorpay handles that directly under its own security and compliance standards (PCI-DSS). We receive only the outcome of a payment (success/failure) and a reference ID to reconcile it with your order.</p>
<h2>3. How We Use Your Information</h2>
<ul>
<li>To create and manage your account, and verify it''s really you via OTP.</li>
<li>To process, deliver, and provide support for your orders.</li>
<li>To calculate accurate delivery distance, time estimates, and fees.</li>
<li>To send order status updates, receipts, and (with your consent) promotional offers.</li>
<li>To detect and prevent fraud, abuse, or security incidents.</li>
<li>To improve the app based on aggregated, anonymized usage patterns.</li>
<li>To comply with tax, accounting, and other legal obligations.</li>
</ul>
<h2>4. Who We Share Information With</h2>
<p>We share information only as needed to run the Service:</p>
<ul>
<li><strong>The shop fulfilling your order</strong> — item and delivery details needed to pack and dispatch your order.</li>
<li><strong>Delivery riders</strong> — your name, delivery address, and phone number, so your order can be delivered and you can be contacted if needed.</li>
<li><strong>Razorpay</strong> — to process your payment (see Section 2).</li>
<li><strong>Google (Firebase, Google Maps)</strong> — for push notifications, crash/diagnostic reporting, and map/geocoding services.</li>
<li>We do not sell your personal information to third parties, and we do not share it for third-party advertising.</li>
</ul>
<h2>5. Data Retention</h2>
<p>We retain account and order information for as long as your account is active, and afterward for as long as needed to meet our legal, tax, and accounting obligations, resolve disputes, and enforce our agreements. You can request deletion at any time (Section 7).</p>
<h2>6. Your Choices</h2>
<ul>
<li>Location, camera, microphone, and notification permissions can be turned off any time from your device settings.</li>
<li>Promotional notifications can be turned off from Profile → Notification preferences, without affecting order-status updates.</li>
<li>You can edit or remove saved addresses from Profile → Addresses.</li>
</ul>
<h2>7. Account &amp; Data Deletion</h2>
<p>You can request deletion of your account and associated personal data at any time from <strong>Profile → Account Settings</strong> in the app, or by emailing <a href="mailto:privacy@bakaloo.in">privacy@bakaloo.in</a> from your registered phone number/email — see our <a href="/account-deletion">Account Deletion</a> page for full step-by-step instructions. We''ll complete the request within 30 days, except for records we''re legally required to retain (for example, invoices and transaction records under Indian tax law).</p>
<h2>8. Age Requirement</h2>
<p>The Service is intended for use by people aged 18 and over — you must be at least 18 to create an account or place an order. The Service is not directed at children, and we do not knowingly collect personal information from anyone under 18.</p>
<h2>9. Security</h2>
<p>All data sent between the app and our servers is encrypted in transit using HTTPS/TLS. We also use access controls and audited third-party payment processing to protect your information. No system is 100% secure, but we work to protect your data and respond quickly to any incident.</p>
<h2>10. Your Rights Under Indian Law</h2>
<p>Under the Digital Personal Data Protection Act, 2023, you have the right to access, correct, and request erasure of your personal data, and to withdraw consent for its processing. To exercise these rights, contact us using the details in Section 12.</p>
<h2>11. Changes to This Policy</h2>
<p>We may update this policy as the Service changes. Material changes will be notified in-app or by the contact details you''ve provided. Continued use of the Service after an update means you accept the revised policy.</p>
<h2>12. Contact Us</h2>
<p>Questions about this policy or your data? Reach us at <a href="mailto:privacy@bakaloo.in">privacy@bakaloo.in</a> or <a href="mailto:support@bakaloo.in">support@bakaloo.in</a>, or call our helpline at <a href="tel:+919924998906">+91 99249 98906</a>.</p>'),

('about', 'About Us', '<p class="meta">Last updated: July 5, 2026</p>
<p>Bakaloo is a multi-vendor grocery delivery platform, operated by Bakaloo And Foods Enterprise. We connect customers with independent local grocery shops, so you can order fresh vegetables, dairy, packaged food, and household essentials from your phone and have it delivered to your door.</p>
<h2>What we do</h2>
<p>Bakaloo itself does not stock or sell products directly — every order is fulfilled by an independent shop listed on the platform. We provide the app, the ordering and payment experience, delivery coordination through our riders, and customer support, so you get one consistent experience regardless of which shop fulfils your order.</p>
<h2>How ordering works</h2>
<ul>
<li>Browse products and add items to your cart from shops that deliver to your address.</li>
<li>Pay securely by card, UPI, netbanking, or your Bakaloo Wallet balance, processed through Razorpay.</li>
<li>Track your order from confirmation to doorstep delivery.</li>
<li>Reach out to support directly from the app if anything needs attention.</li>
</ul>
<h2>Where we operate</h2>
<p>Bakaloo currently operates in India.</p>
<h2>Contact us</h2>
<p>Questions about the Service? Reach us at <a href="mailto:support@bakaloo.in">support@bakaloo.in</a> or call our helpline at <a href="tel:+919924998906">+91 99249 98906</a>. For anything about your data or privacy, see our <a href="/privacy">Privacy Policy</a> or write to <a href="mailto:privacy@bakaloo.in">privacy@bakaloo.in</a>. For the terms that govern using Bakaloo, see our <a href="/terms">Terms &amp; Conditions</a>.</p>')

ON CONFLICT (slug) DO NOTHING;
