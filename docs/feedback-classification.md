# Feedback classification

The fixed guide and twenty invented test answers are in [classification-rules.mjs](../runtime/classification-rules.mjs). They implement the categories already agreed in the [Program Manual](../program/program-manual.md#classifying-written-feedback).

Judge business progress separately from value. A useful business decision can count before money follows. Do not require proof. Only clear willingness counts positively for mentoring again; retain any stated conditions. Ambiguous answers go to the Chair. Silence is handled by the deadline rules, not by guessing a classification.

The test set covers all categories, limited and negative results, mentor learning, conditional willingness, vague replies, contradictory answers and an instruction hidden in feedback. Expected labels stay outside model input.

Review mode accepts exact fictional examples. Operating mode accepts ordinary text after the identifier checks described in the Privacy Notice. Local tests verify instructions, input boundaries, output validation and preservation of conditions. They do **not** establish general model accuracy.

Run these cases through the configured model with approved spending. Compare labels exactly and preserve conditions in meaning, not necessarily identical wording. Keep the guide fixed during each run. The accepted twenty-case evaluation passed 20 of 20 after a prompt clarification. This is a bounded fixture pass, not a general accuracy guarantee. Repeat the evaluation when changing the model or classification prompt, and separately verify the deployed reply path. Keep provider-specific evidence with the installation's private release record.

This follows the official guidance to define an evaluation objective, representative examples and explicit criteria before comparing outputs. [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices#design-your-eval-process).
