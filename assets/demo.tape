Output assets/demo.gif
Set Width 1100
Set Height 660
Set FontSize 15
Set Padding 30
Set TypingSpeed 40ms
Set Theme "Dracula"
Set Framerate 24

Type "export KIMI_GUARD_HOME=/tmp/kguard-demo/guard"
Enter
Sleep 300ms
Type "export KIMI_CONFIG_PATH=/tmp/kguard-demo/config.toml"
Enter
Sleep 300ms
Type "npm i -g kimi-guard"
Enter
Sleep 4200ms
Type "kguard install"
Enter
Sleep 1600ms
Type "kguard doctor"
Enter
Sleep 2600ms
Type 'kguard run "find all TODO markers" --exec env FAKE_SCENARIO=loop node test/wire/fake-kimi.mjs'
Enter
Sleep 5200ms
Type "kguard status"
Enter
Sleep 3200ms
Type "kguard budget"
Enter
Sleep 1800ms
