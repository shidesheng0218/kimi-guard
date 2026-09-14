---
name: "False positive: the guard blocked legitimate work"
about: The guard blocked something it shouldn't have — this data calibrates the detectors
title: "[FP] <detector> blocked <what you were doing>"
labels: ["false-positive"]
---

## What got blocked

- **Block id**: <!-- from the block message, e.g. #42 -->
- **Detector**: <!-- repeat / noGain / churn / explore / ... -->
- **Tool**: <!-- e.g. Grep, Bash, WriteFile -->
- **The exact reason shown**: <!-- paste from `agentguard blocks` (the reason line under the entry) -->

```
<paste the block entry here>
```

## What you were actually doing (why this was legitimate)

<!-- one or two sentences — e.g. "I was polling a long build with git status" -->

## Your config

```
<paste `agentguard config export` output, or just the [repeat]/[churn]/... section>
```

## Would an exemption fix it?

<!-- e.g. "yes, exemptPatterns for `git status`" — say so and we'll fold it into calibrate's suggestions -->
