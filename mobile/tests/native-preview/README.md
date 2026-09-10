# Isolated native scanner preview

Runs the production camera and theme without login, business data or API uploads.
The camera is real, not a mocked view. Server crop/quality actions deliberately
fail here. Approval only displays an image count, never creates an expense.

Build/install the Android debug app with the local scanner module. From this
directory run `../../node_modules/.bin/expo start --localhost --port 8081`, then
`adb -s emulator-5554 reverse tcp:8081 tcp:8081` and launch `app.finsight.mobile`.
If port 8081 is occupied, do not stop another developer's server: choose another
port and set the app's development-server host to that port in its developer menu.
Use a task-owned emulator; do not install over someone's physical-device app
without their approval. Do not run this harness in a production build.

Emulator screenshots verify layout and native integration, not real-receipt
capture accuracy. Instrumented synthetic CV tests live in the module's
`android/src/androidTest` directory.

Configuration-change regression: with the rebuilt app running, change Android
font size to 1.3x and back to 1.0x without restarting. Confirm text scales and
Gallery opens, imports a synthetic receipt, returns to review, and opens again
through Retake. Restore the original device settings afterward. The app's
`withScannerFontScale` plugin prevents the known font-size activity recreation
path; it is not a general guarantee for process death or every configuration.
