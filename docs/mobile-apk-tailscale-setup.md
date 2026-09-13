# FinSight Android APK setup with Tailscale

This guide lets teammates use the standalone FinSight Android APK while the
development API runs on the host laptop. Expo Go is not required. The phone and
laptop can use different Wi-Fi networks or mobile data because Tailscale
provides the private connection between them.

This is a development setup. The laptop must remain powered on, connected to
the internet and Tailscale, and running the FinSight backend.

## Set the development address

```text
API base URL: http://<TAILSCALE_IP>:4000/api/v1
Health check: http://<TAILSCALE_IP>:4000/api/v1/health/live
```

Replace `<TAILSCALE_IP>` with the host laptop's current address from
`tailscale ip -4`. Replace `/path/to/FinsightV1` in later commands with the
actual clone location.

The `100.x.x.x` address is a private Tailscale address. It is reachable only
from devices that the team owner has allowed into the same tailnet.

## What the team owner does

### 1. Invite each teammate to Tailscale

Open the Tailscale admin console and invite each teammate using their own email
address. Do not share one Tailscale login among the team.

After a teammate joins, confirm that their device appears:

```bash
tailscale status
```

### 2. Start the API

Run this from the FinSight repository root:

```bash
cd /path/to/FinsightV1
npm run dev --prefix backend
```

Keep that terminal open. Use a second terminal for receipt processing, CSV
imports, and background analysis:

```bash
cd /path/to/FinsightV1
npm run worker:dev --prefix backend
```

Confirm that the API responds through Tailscale:

```bash
curl http://<TAILSCALE_IP>:4000/api/v1/health/live
```

The response should contain `"status":"ok"`.

### 3. Build the APK when the mobile code changes

Check that `mobile/.env` contains:

```env
EXPO_PUBLIC_API_BASE_URL=http://<TAILSCALE_IP>:4000/api/v1
```

Then build from the repository root:

```bash
npm run android:apk --prefix mobile
```

The generated file is:

```text
mobile/android/app/build/outputs/apk/release/app-release.apk
```

The Android build folder is gitignored, so pushing the code does not make the
APK downloadable. Upload `app-release.apk` to the team's private file share or
attach it to a GitHub Release. Do not commit the APK to the source repository.

Generate a checksum and send it beside the APK so teammates can check that the
download completed correctly:

```bash
sha256sum mobile/android/app/build/outputs/apk/release/app-release.apk
```

## What each teammate does

### 1. Connect the phone to the tailnet

1. Accept the Tailscale invitation using your own account.
2. Install Tailscale from Google Play on the Android phone.
3. Sign in with the invited account and turn on the Tailscale connection.
4. Open this address in the phone's browser:

   ```text
   http://<TAILSCALE_IP>:4000/api/v1/health/live
   ```

Do not continue until the browser shows a response containing `"status":"ok"`.

The phone does not need to use the same Wi-Fi as the laptop. Both devices need
internet access, an active Tailscale connection, and permission to communicate
inside the team's tailnet.

### 2. Download and install the APK

1. Download the current `app-release.apk` from the link provided by the team
   owner.
2. If Android asks, allow the browser or file manager to install unknown apps.
3. Open the downloaded APK and select **Install** or **Update**.
4. Open FinSight and sign in.

USB debugging is not required for this method.

### Optional: install from a developer laptop with ADB

For an ADB install, enable Developer options and USB debugging, connect the
phone by USB, and approve the authorization prompt on the phone. From the
repository root, run:

```bash
adb devices
adb install -r mobile/android/app/build/outputs/apk/release/app-release.apk
```

Run the command inside the cloned `FinsightV1` folder. If you run it from the
home folder, the relative APK path will not exist.

## Daily startup checklist

On the host laptop:

1. Connect Tailscale.
2. Run the backend API.
3. Run the worker when testing receipts, imports, or analysis.
4. Keep the laptop awake and online.

On each phone:

1. Connect Tailscale.
2. Check the health URL if login reports a connection error.
3. Open FinSight. Expo and Metro are not needed for the installed APK.

## Troubleshooting

### The health address does not open on the phone

On the host laptop, run:

```bash
tailscale status
ss -ltnp '( sport = :4000 )'
curl http://<TAILSCALE_IP>:4000/api/v1/health/live
```

Check that the teammate's phone is connected in the Tailscale app and appears
in `tailscale status`. The team owner may also need to correct the tailnet
access rules.

### The app still shows a `192.168.x.x` or old API address

The phone has an older APK. Rebuild after setting the Tailscale API address,
share the new file, and install it as an update.

### ADB says `no devices/emulators found`

Enable USB debugging, reconnect the cable, select file transfer mode if needed,
and approve the computer on the phone. Then run `adb devices` again.

### ADB says `failed to stat ... app-release.apk`

Change into the repository first:

```bash
cd /path/to/FinsightV1
adb install -r mobile/android/app/build/outputs/apk/release/app-release.apk
```

### Android reports a package or signature conflict

The existing app may have been signed with a different key. Uninstalling it
can remove locally stored app data, so confirm that losing that data is safe
before uninstalling. Then install the current APK again.

### Receipt or CSV work stays pending

Start the worker on the host laptop:

```bash
npm run worker:dev --prefix backend
```

## Development limits

- This APK is for internal testing and is not a Play Store production build.
- The current build is development-signed. Keep the signing method consistent
  so Android can install later builds as updates.
- If the host laptop is off, asleep, disconnected, or the backend has stopped,
  the mobile app cannot reach the API.
- Do not place Supabase keys, passwords, or other secrets in this document or
  in an APK download message.
