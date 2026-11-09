# PracticeCLI quiz JSON reference

This reference follows the model and sample files in the PracticeCLI repository:

- `resources/example.json`
- `internal/practice/model/practicefile.go`
- `internal/practice/model/translation.go`
- `internal/practice/model/translationmapping.go`
- `internal/practice/session/answers.go`

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
    }
  ]
}
```

`metadata.mappings` is an array of mapping names; an entry may append a mapping-specific leniency value using `name;leniency`. Each `data` item has a `baseline`, optional `question` and `leniency`, and a `mappings` object keyed by the names declared in metadata. A metadata question template can use `%data.baseline%`; a per-item `question` can override it.

## Supported answer types

The PracticeCLI model declares three `QuestionType` values:

- **`SimpleAnswer`** — accepted text answers; use `answer` as a list of accepted spellings or equivalent forms.
- **`MultipleChoice`** — answer choices plus a 1-based `correctChoice` index.
- **`TrueOrFalse`** — declared in the model, but the current answer-checking switch handles only `SimpleAnswer` and `MultipleChoice`. Do not emit `TrueOrFalse` as a playable type unless the target PracticeCLI version has implemented its checking behavior. A true/false prompt can currently be represented as `MultipleChoice` with choices such as `True` and `False`.

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

## Legacy string forms

The parser also accepts compact strings:

- `"answer"` — one `SimpleAnswer` value.
- `"answer;alternate"` — multiple accepted `SimpleAnswer` values.
- `"2|first;second;third"` — `MultipleChoice`, with correct index 2.
- `"MultipleChoice|2|first;second;third"` — typed choice form.
- `"TrueOrFalse|1|True;False"` — parses as a typed mapping, but is not currently handled by answer checking (see above).

Prefer JSON objects for generated quiz files because they are easier to review and less prone to delimiter errors.
