# Google Play: Internal testing par app daalne ka procedure

## Status (29 Oct 2026)
- App "Gaincafe CRM" (com.gaincafecrm) developer account "Pranshuj" mein bani (app id 4975715521537924398).
- Internal testing release "1.0.0 (1) internal" published, 29 Oct 2:47 PM.
- Testers list "Gaincafe internal": vibhanshu@gaincafe.com, vibhanshukumarshubham46@gmail.com.
- Tester join link: https://play.google.com/apps/internaltest/4701739869294364811
- Jab tak store listing complete aur review nahi hota, testers ko app ka naam "com.gaincafecrm (unreviewed)" dikhega. Ye normal hai.
- 29 Oct shaam: v1.0.1 (versionCode 2) bana — "Push to portal" ab 100-100 logs ke batches mein bhejta hai (CRM ki 422 limit), WIFI_ call types INCOMING/OUTGOING mein map. Files: `GaincafeCRM-v1.0.1.apk` (sideload), `GaincafeCRM-v1.0.1-playstore.aab`.
- Internal testing release "2 (1.0.1)" published 29 Oct 6:32 PM (Play ke notes: "Available to internal testers").
- 29 Oct raat, v1.0.2 (versionCode 3): code review mein 3 gaps mile aur fix kiye — (1) offline mein queue hui batches sirf tab jaati thi jab koi nayi call ho; ab har auto-sync (net wapas aane par, 30 min, app foreground, background fetch) pehle queue drain karta hai; (2) "Push to portal" mein purani calls ki recordings tabhi lagti thi jab file last sync ke baad ki ho, ab push ki sabse purani call tak dekhta hai; (3) CRM se reject (422) hua batch 7 din tak park rehta hai, baar-baar nahi jaata. Files: `GaincafeCRM-v1.0.2.apk`, `GaincafeCRM-v1.0.2-playstore.aab`.
- 30 Oct 4:52 PM: Internal testing release "3 (1.0.2)" published, "Available to internal testers". Share ke liye Play Console → App bundle explorer → 3.aab → Downloads → "Signed, universal APK" lo (Google key se signed, Play app ke saath conflict nahi).
- 29 Oct raat, v1.0.1 rebuild: recordings ab ek saath sirf 3 upload hoti hain (pehle sab ek saath → timeouts), upload timeout 60 s aur timeout par native upload cancel; CRM 400/413/422 wala batch ab 16 baar retry nahi hota, failed archive mein jaake baaki batches chalte rehte hain; "latest call recording missing" ab poora push block nahi karta (sirf warn, recording agli sync mein retry); Call logs par "Push all" ab storage se exact acknowledged IDs padhta hai.

## 30 Oct: "testers download nahi kar paa rahe" + "Play par 15 MB" ki jaanch
- **Tester list ka issue (fix ho gaya):** Play Console mein do email lists thi: "Gaincafe internal" (2 emails, tick thi) aur
  "1st Tester" (5 emails: abhayprajapati1000@gmail.com, ray@gaincafe.com, team@gaincafe.com, vibhanshu@gaincafe.com,
  vibhanshukumarshubham46@gmail.com) jo tick NAHI thi. Isliye abhay, ray aur team@gaincafe.com test join hi nahi kar sakte the.
  Ab dono lists tick karke save kar di. Naye tester hamesha list mein daalo AUR list ka checkbox tick karke Save karo.
- **15–16 MB download normal hai:** Play AAB se har phone ke liye alag chhota APK banata hai (sirf uska CPU, screen density,
  language). Play Console khud "Size for new installs: 16.4 MB" dikhata hai. Hamari 34 MB APK "universal" hai (sab kuch ek saath).
  Ye koi bug nahi hai, kuch fix nahi karna.
- **Sideload APK aur Play app ek saath nahi chalte (signature alag hai):** Play App Signing on hai, isliye Play wali app Google ki
  app-signing key se signed hai (SHA-256 B7:D6:4D:90...) aur hamari local APK upload key se (SHA-256 C7:EC:89:AF...).
  Jis phone par local APK install hai, usme Play se install "Can't install" dega, aur ulta bhi. Rule: ek phone par ek hi source.
  Play se lene se pehle local wali uninstall karo.
- **Dono ko ek jaisa karne ka tareeka:** Play Console → Release → App bundle explorer → version → **Downloads** tab →
  "Signed, universal APK" download karo. Ye APK Google ki key se signed hai, isliye isko share karne par Play wali app ke upar
  seedha update ho jaata hai. Aage se share ke liye yahi APK use karo, local build wali nahi.
- Play App Signing page par "Install base 0.0%" tha, yaani 30 Oct subah tak kisi ne Play se install nahi kiya tha.
- Testers ke liye checklist: (1) email list mein ho aur list tick ho, (2) phone par Play Store usi Google account se login ho,
  (3) join link kholke "Become a tester" dabaya ho, (4) local APK uninstall ho, (5) 15–30 min wait, Play Store app ka cache clear
  karke dobara dekho. App ka naam "com.gaincafecrm (unreviewed)" dikhna normal hai.

## Jo taiyaar hai (is repo mein)
- Upload keystore: `android/app/gaincafe-upload.keystore` (git-ignored)
- Password aur alias: `android/keystore.properties` (git-ignored). **Iska backup kahin safe rakho (password manager / drive).** Ye kho gaya to Play par kabhi update nahi de paoge.
- Signed bundle: `GaincafeCRM-v1.0.0-playstore.aab` (project ke bagal wale folder mein)
- Package name: `com.gaincafecrm`, versionCode 1, versionName 1.0.0, targetSdk 36

Har nayi upload par `android/app/build.gradle` mein `versionCode` +1 karo (2, 3, ...) aur
`versionName` badlo, phir `cd android && .\gradlew.bat bundleRelease`.

## Play Console steps (ek baar)
1. https://play.google.com/console → Developer account banao (ek baar $25). Organisation ke naam se banao to
   D-U-N-S number maangega; personal account turant ban jata hai.
2. **Create app** → naam "Gaincafe CRM", default language English (India), App, Free.
3. Left menu **Testing → Internal testing** → **Create new release**.
4. **App integrity**: "Play App Signing" ko Google manage karne do (default). Humari keystore "upload key" ban jati hai.
5. **Upload** → `GaincafeCRM-v1.0.0-playstore.aab`. Release name khud bhar jayega (1 (1.0.0)).
6. Release notes mein likho: "Internal test build: CRM login, leads, call sync."
7. **Testers** tab → "Create email list" → naam "Gaincafe internal" → jo bhi Gmail IDs test karengi, comma se daal do → Save → list ko tick karo.
8. **Review release → Start rollout to Internal testing.**
9. Testers tab par "Copy link" → ye link testers ko bhejo. Wo link kholke "Become a tester" dabayenge, phir Play Store se app install hogi (10–15 min lag sakte hain pehli baar).

Internal testing mein Google ki policy review nahi hoti, release turant live hota hai. 100 testers tak.

## Dashboard mein jo "Set up your app" tasks aayenge
Internal testing ke liye ye zaroori nahi, par production se pehle karne padenge:
- Privacy policy URL (website par ek page). READ_CALL_LOG jaise permissions ki wajah se ye zaroori hai.
- App access: "All functionality is available without special access" **nahi** chalega, kyunki login chahiye.
  "All or some functionality is restricted" chuno aur ek test agent ka login + workspace do (reviewer ke liye).
- Content rating questionnaire, Target audience (18+), Data safety form (call logs, phone number, email collect hote hain; encrypted in transit; user delete request).
- **Sensitive app permissions declaration** (Policy → App content → Sensitive permissions):
  app `READ_CALL_LOG`, `READ_PHONE_STATE`, `READ_PHONE_NUMBERS` maangti hai. Google in permissions ko restricted maanta hai;
  production review mein use case likhna padega. Sabse kareeb wala use case: "Cross-device synchronization or transfer of SMS or calls"
  (call logs CRM par sync hoti hain). Ye Google reject bhi kar sakta hai; tab app ko default dialer banana ya
  CRM web par call log manual rakhna padega. Internal testing is par nahi rukti.

## Dhyan rakhne wali baatein
- Ye AAB upload key se signed hai, debug key se nahi. Jin phones par purani sideload wali APK hai, unpar Play wali app install karne se pehle purani uninstall karni padegi (signature alag hai).
- Abhi build sirf arm64-v8a (64-bit) ke liye hai; 2017 ke baad ke lagbhag sabhi phones chalenge. Purane 32-bit phones ke liye
  `android/gradle.properties` mein `reactNativeArchitectures=armeabi-v7a,arm64-v8a` karke dobara bundle banana hoga.
- Play App Signing on hone ke baad agar kabhi keystore kho jaye to Play Console se "upload key reset" request kar sakte ho.
