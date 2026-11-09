---
name: quiz-gen
description: Create or improve quizzes in the PracticeCore JSON format for PracticeCLI and the browser, including MultiAnswer questions, with answer-choice cue review and a final wording cleanup.
---

# Quiz Gen

Use this skill when creating or revising a quiz consumed by PracticeCore, including the PracticeCLI app and browser client. Read `references/practicecore-json.md` before writing a file; it documents the shared schema and supported answer types.

## Inputs

Use the user's requested topic, source material, question count, output location, and difficulty. If a count is not specified, ask only when the surrounding task does not imply one. Check existing quiz files or supplied material for topic coverage and question overlap before drafting. Write new items rather than copying source questions unless the user asks for reuse.

## Draft and review workflow

1. Draft the requested number of questions and answer choices. Keep each stem focused on one learning objective. Use `MultipleChoice` for one correct option, `MultiAnswer` for selecting a set of correct options, and `SimpleAnswer` for interchangeable accepted text answers. For `MultiAnswer`, state “Select all that apply” (or the required count when appropriate), make each option independently assessable, and verify the complete correct set. For `MultipleChoice`, make the correct answer uniquely defensible.
2. Independently rank the options for each item using only these answer-choice cues:

   - The correct option stands out because it is longer or more detailed.
   - Distractors introduce unrelated topics or concepts.
   - The correct answer can be guessed through general-knowledge elimination without understanding the quiz topic.

   Ask reviewers to estimate cue-based likelihoods. Treat any option above 50% as a rewrite candidate. Check factual accuracy and the answer key separately from cue scoring.

   For `MultiAnswer`, assess each option's apparent correctness separately; probabilities need not sum to 100%. Apply the rewrite threshold to cue-revealed correct options, not to legitimate subject knowledge. Review distractors for conspicuous wording that makes them easy to reject.

3. For flagged items, generate new distractors that are plausible for someone who understands the broad topic, but wrong for the specific scenario. Keep choices similar in length, grammar, specificity, and subject area. Avoid near-paraphrases and accidental extra correct options; preserve the intended correct set for `MultiAnswer`.
4. Have a different independent reviewer rank the revised items. Repeat steps 3–4 for `rewrite_rounds` cycles: default **3**, configurable from **0 to 5**. Stop early if no items remain flagged. Never exceed five rewrite cycles. If a strong choice set cannot be made, rephrase the stem or replace the item with a clearer topic question.
5. After the final ranking pass, do a language cleanup pass across every stem and option. Remove ambiguous pronouns, hidden assumptions, awkward wording, and accidental clues; preserve meaning, correct answers, and keys. Check technical claims against authoritative sources when accuracy is uncertain or version-sensitive.

When using subagents, keep rankers independent of the generator, give all agents the same quiz version, and use the same model for each role. If the user specifies a model, follow that preference; otherwise use the cheapest, most efficient model consistently, e.g. GPT-6-Luna.

## Final validation

Before delivery:

- Validate the JSON parses and matches the PracticeCore structure in the reference. Use the target version's `practicecore.ParseJSON` when available.
- Confirm every item has a non-empty stem, valid mapping key, recognized question type, and non-empty answer list.
- For `MultipleChoice`, verify `correctChoice` is 1-based and points to exactly one correct answer.
- For `MultiAnswer`, verify `correctChoices` is a non-empty array of unique integers in `1..len(answer)`, each option is non-blank, and the indexes identify every correct option and no distractors. Use `correctChoices`, not `correctChoice`.
- Check for duplicate or near-duplicate stems and verify keys after any option reordering.
- Balance answer positions when the quiz format and question count make that practical.
- Report the output file, question count, question types used, and any remaining limitations.
