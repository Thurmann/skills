# PracticeCore quiz JSON reference

PracticeCore owns the shared JSON model, validation, and grading used by PracticeCLI and the browser's WebAssembly engine. This reference follows these files in `github.com/thurmann/practicecore`:

- `model/practicefile.go`
- `model/metadata.go`
- `model/translation.go`
- `model/translationmapping.go`
- `core.go`

PracticeCLI's `resources/example.json` and `resources/multi_answer_example.json` provide client examples. If targeting a different engine version, inspect that version's model and parser before relying on newer modes.

## File shape

```json
{
  "title": "Quiz title",
  "metadata": {
    "baseline": "question",
    "mappings": ["answer"],
    "leniency": "0.1",
    "question": "%data.baseline%"
  },
  "data": [
    {
      "baseline": "Question stem",
      "mappings": {
        "answer": {
          "type": "MultipleChoice",
          "answer": ["Option A", "Option B", "Option C", "Option D"],
          "correctChoice": 2
        }
      }
    },
    {
      "baseline": "Which numbers are prime? Select all that apply.",
      "mappings": {
        "answer": {
          "type": "MultiAnswer",
          "answer": ["2", "4", "5", "9"],
          "correctChoices": [1, 3]
        }
      }
    }
  ]
}
```

`metadata.mappings` is an array of mapping names; an entry may append a mapping-specific leniency value using `name;leniency`. Each `data` item has a `baseline`, optional `question` and `leniency`, and a `mappings` object keyed by the names declared in metadata. A metadata question template can use `%data.baseline%`; a per-item `question` can override it.

Use consistent lowercase mapping names. Leniency values are JSON strings, such as `"0.1"`, and apply to free-text/numeric comparison rather than choice selection. The top-level file shape remains `title`, `metadata`, and `data`; MultiAnswer adds a mapping type and answer-key field, not a new file envelope. Mixed question types may share a file.

## Supported answer types

The model declares four `QuestionType` values; three are playable:

- **`SimpleAnswer`** — accepted text answers; use `answer` as a list of accepted spellings or equivalent forms.
- **`MultipleChoice`** — answer choices plus a 1-based `correctChoice` index.
- **`MultiAnswer`** — answer choices plus a non-empty `correctChoices` array of unique 1-based indexes. The user selects a set of options.
- **`TrueOrFalse`** — declared but explicitly rejected by the current PracticeCore file parser. Represent true/false prompts as `MultipleChoice` with choices such as `True` and `False`.

For predictable output, use the object form for mappings:

```json
{
  "type": "SimpleAnswer",
  "answer": ["accepted answer", "accepted alternative"]
}
```

```json
{
  "type": "MultipleChoice",
  "answer": ["First", "Second", "Third", "Fourth"],
  "correctChoice": 3
}
```

`correctChoice` is a 1-based index into `answer`.

```json
{
  "type": "MultiAnswer",
  "answer": ["2", "4", "5", "9"],
  "correctChoices": [1, 3]
}
```

For `MultiAnswer`:

- `answer` must contain at least one option, with no empty or whitespace-only strings.
- `correctChoices` must contain at least one integer, with no duplicates; every index must lie in `1..len(answer)`. The engine permits a single correct index, though `MultipleChoice` normally communicates that intent better.
- Emit `correctChoices` rather than the singular `correctChoice`. Recompute every index whenever options are reordered; the stored key always refers to the file's option order.
- `answer` lists selectable options, including distractors. It does not list interchangeable text responses as it does for `SimpleAnswer`.
- An exact set match earns 1 point regardless of selection order. Partial credit is `max(0, (correct selected - wrong selected) / total correct)`. For the example, selecting only option 1 earns 0.5; selecting 1 and 2 earns 0; selecting 1 and 3 earns 1. Retries do not accumulate points; skips and reveals earn 0.

Keep prompts explicit about selecting multiple options, and make the whole key defensible. Do not add scoring configuration fields to the quiz JSON; scoring belongs to the engine.

## Legacy string forms

The parser also accepts compact strings:

- `"answer"` — one `SimpleAnswer` value.
- `"answer;alternate"` — multiple accepted `SimpleAnswer` values.
- `"2|first;second;third"` — `MultipleChoice`, with correct index 2.
- `"MultipleChoice|2|first;second;third"` — typed choice form.
- `"MultiAnswer|1,3|first;second;third"` — typed multi-answer form with comma-separated correct indexes.

`"TrueOrFalse|1|True;False"` is not a supported practice file mapping: the current file parser rejects it.

Prefer JSON objects for generated quiz files because they are easier to review and less prone to delimiter errors.
