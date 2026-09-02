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
Type "export CLAUDE_SETTINGS_PATH=/tmp/kg/claude/settings.json"
Enter
Sleep 200ms
Type "npm i -g @shidesheng0218/agentguard"
Enter
Sleep 2200ms
Type "agentguard install"
Enter
Sleep 1400ms
Type "agentguard doctor"
Enter
Sleep 2000ms
Type 'export DEMO="env FAKE_SCENARIO=loop node test/wire/fake-kimi.mjs"'
Enter
Sleep 200ms
Type 'agentguard run "find all TODO markers" --exec $DEMO'
Enter
Sleep 3500ms
Type "agentguard status"
Enter
Sleep 2600ms
Type "agentguard budget"
Enter
Sleep 1500ms
