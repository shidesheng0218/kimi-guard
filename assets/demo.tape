Output assets/demo.gif
Set Width 800
Set Height 640
Set FontSize 14
Set Padding 24
Set TypingSpeed 12ms
Set Theme "Dracula"
Set Framerate 24

Type "export KIMI_GUARD_HOME=/tmp/kg/guard"
Enter
Sleep 200ms
Type "export KIMI_CONFIG_PATH=/tmp/kg/config.toml"
Enter
Sleep 200ms
Type "npm i -g kimi-guard"
Enter
Sleep 2200ms
Type "kguard install"
Enter
Sleep 1200ms
Type "kguard doctor"
Enter
Sleep 2000ms
Type 'export DEMO="env FAKE_SCENARIO=loop node test/wire/fake-kimi.mjs"'
Enter
Sleep 200ms
Type 'kguard run "find all TODO markers" --exec $DEMO'
Enter
Sleep 3500ms
Type "kguard status"
Enter
Sleep 2600ms
Type "kguard budget"
Enter
Sleep 1500ms
