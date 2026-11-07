#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
codex_root="${CODEX_HOME:-$HOME/.codex}"
validator="$codex_root/skills/.system/skill-creator/scripts/quick_validate.py"

if [[ ! -f "$validator" ]]; then
  echo "Codex skill-creator validator not found: $validator" >&2
  exit 2
fi
found=0
for skill_dir in "$repo_root"/skills/*; do
  [[ -d "$skill_dir" && -f "$skill_dir/SKILL.md" ]] || continue
  if python3 -c 'import yaml' >/dev/null 2>&1; then
    python3 "$validator" "$skill_dir"
  elif command -v ruby >/dev/null 2>&1; then
    ruby -ryaml -e '
      dir = ARGV.fetch(0)
      path = File.join(dir, "SKILL.md")
      text = File.read(path)
      match = text.match(/\A---\n(.*?)\n---\n/m) or abort("Missing or invalid YAML frontmatter: #{path}")
      data = YAML.safe_load(match[1])
      abort("Expected a YAML mapping: #{path}") unless data.is_a?(Hash)
      abort("Skill name must match folder: #{path}") unless data["name"] == File.basename(dir)
      description = data["description"]
      abort("Missing/invalid description: #{path}") unless description.is_a?(String) && !description.empty? && description.length <= 1024
      abort("Unexpected frontmatter property: #{path}") unless (data.keys - %w[name description license allowed-tools metadata]).empty?
      abort("Unfinished TODO: #{path}") if text.include?("[TODO:")
      puts "#{data["name"]}: frontmatter PASS"
    ' "$skill_dir"
  else
    echo "Need PyYAML for quick_validate.py or Ruby for the built-in fallback." >&2
    exit 2
  fi
  found=1
done
if [[ "$found" -eq 0 ]]; then
  echo "No skills found under $repo_root/skills" >&2
  exit 1
fi
