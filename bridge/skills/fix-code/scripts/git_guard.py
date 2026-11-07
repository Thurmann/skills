#!/usr/bin/env python3
"""Create isolated task branches and detect protected-ref/history changes.

This is an explicit checkpoint helper, not a hook or enforcement sandbox.
No command pushes, rebases, resets, amends, or changes the original checkout.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid


class GuardError(Exception):
    pass


def git(repo, *args, optional=False):
    result = subprocess.run(['git', '-C', str(repo), *args], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode and not optional:
        # Do not echo raw stderr: repository hooks/config may expose credentials.
        raise GuardError('Git command failed: ' + args[0] +
                         ' (exit ' + str(result.returncode) + '). Inspect locally.')
    return result.stdout.strip() if result.returncode == 0 else None


def root_of(repo):
    return Path(git(repo, 'rev-parse', '--show-toplevel')).resolve()


def common_of(repo):
    path = Path(git(repo, 'rev-parse', '--git-common-dir'))
    return (path if path.is_absolute() else Path(repo) / path).resolve()


def ref_tip(repo, ref):
    return git(repo, 'rev-parse', '--verify', ref, optional=True)


def remote_digest(repo):
    config = git(repo, 'config', '--get-regexp', r'^remote\..*\.(url|pushurl)$',
                 optional=True) or ''
    return hashlib.sha256(config.encode()).hexdigest()


def resolve_base(repo, requested):
    if requested:
        base = requested
    else:
        base = git(repo, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD',
                   optional=True)
        if not base:
            for candidate in ['refs/heads/main', 'refs/heads/master', 'refs/heads/trunk']:
                if ref_tip(repo, candidate):
                    base = candidate
                    break
    if not base:
        raise GuardError('Base is ambiguous; supply --base with the verified base ref.')
    if base.startswith('-') or not base.strip():
        raise GuardError('Invalid base ref.')
    commit = git(repo, 'rev-parse', '--verify', base + '^{commit}', optional=True)
    if not commit:
        raise GuardError('Base must resolve to an existing commit; initialize an empty repo separately.')
    return base, commit


def protected_refs(repo, base, extras):
    names = {'main', 'master', 'trunk'}
    remote_head = git(repo, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD',
                      optional=True)
    if remote_head and remote_head.startswith('refs/remotes/origin/'):
        names.add(remote_head[len('refs/remotes/origin/'):])
    canonical = git(repo, 'rev-parse', '--symbolic-full-name', base, optional=True) or ''
    if canonical.startswith('refs/heads/'):
        names.add(canonical[len('refs/heads/'):])
    elif canonical.startswith('refs/remotes/'):
        names.add(canonical[len('refs/remotes/'):].split('/', 1)[-1])
    names.update(extras)
    refs = {}
    for name in sorted(names):
        if name.startswith('-'):
            raise GuardError('Invalid protected branch name.')
        ref = name if name.startswith('refs/heads/') else 'refs/heads/' + name
        refs[ref] = ref_tip(repo, ref)  # None also protects against creating main later.
    return refs


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix='.checkpoint-', dir=str(path.parent))
    try:
        with os.fdopen(handle, 'w') as output:
            json.dump(state, output, indent=2)
            output.write('\n')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def check(state_path):
    state_path = Path(state_path).expanduser().resolve()
    try:
        state = json.loads(state_path.read_text())
    except (OSError, ValueError) as error:
        raise GuardError('Cannot read guard state.') from error
    if state.get('version') != 1:
        raise GuardError('Unsupported guard state version.')
    worktree = Path(state['worktree'])
    if not worktree.is_dir() or root_of(worktree) != worktree.resolve():
        raise GuardError('Task worktree is missing or no longer the recorded repository root.')
    if str(common_of(worktree)) != state['git_common_dir']:
        raise GuardError('Task worktree belongs to a different repository.')
    branch = git(worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD', optional=True)
    if branch != state['branch']:
        raise GuardError('Task is detached or checked out on the wrong branch.')
    for ref, before in state['protected_refs'].items():
        if ref_tip(worktree, ref) != before:
            raise GuardError('Protected ref changed: ' + ref + '. Preserve state; do not reset it.')
    if remote_digest(worktree) != state['remote_digest']:
        raise GuardError('Remote routing configuration changed; validate the delivery target before proceeding.')
    for marker in ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']:
        marker_path = Path(git(worktree, 'rev-parse', '--git-path', marker))
        if not marker_path.is_absolute():
            marker_path = worktree / marker_path
        if marker_path.exists():
            raise GuardError('An unfinished Git operation is present: ' + marker)
    head = git(worktree, 'rev-parse', '--verify', 'HEAD')
    for label, ancestor in [('base', state['base_commit']),
                            ('last checkpoint', state['checkpoint_head'])]:
        result = subprocess.run(['git', '-C', str(worktree), 'merge-base',
                                 '--is-ancestor', ancestor, head],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            raise GuardError('HEAD no longer descends from the ' + label + '; possible history rewrite.')
    state['checkpoint_head'] = head
    save_state(state_path, state)
    return {'ok': True, 'branch': branch, 'base': state['base_ref'],
            'head': head, 'worktree': str(worktree), 'state': str(state_path)}


def start(repo, name, requested_base=None, destination=None, protect=()):
    repo = root_of(Path(repo).expanduser().resolve())
    base, commit = resolve_base(repo, requested_base)
    protected = protected_refs(repo, base, protect)
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:48]
    if not slug:
        raise GuardError('Task name must contain a letter or digit.')
    identity = uuid.uuid4().hex
    branch = 'fix-code/' + slug + '-' + identity[:10]
    git(repo, 'check-ref-format', '--branch', branch)
    if ref_tip(repo, 'refs/heads/' + branch):
        raise GuardError('Fresh branch unexpectedly exists; choose another task identity.')
    common = common_of(repo)
    worktree_name = 'fix-code-' + slug + '-' + identity[:10]
    worktree = (Path(destination).expanduser().resolve() if destination else
                Path.home() / 'workspace' / 'worktrees' / repo.name / worktree_name)
    if worktree.exists():
        raise GuardError('Worktree destination exists; no files were replaced.')
    if worktree == repo or repo in worktree.parents or worktree in repo.parents:
        raise GuardError('Worktree destination must be outside and separate from the original repository.')
    worktree.parent.mkdir(parents=True, exist_ok=True)
    digest = remote_digest(repo)
    git(repo, 'worktree', 'add', '-b', branch, str(worktree), commit)
    state = {'version': 1, 'original_repo': str(repo), 'git_common_dir': str(common),
             'worktree': str(worktree), 'branch': branch, 'base_ref': base,
             'base_commit': commit, 'checkpoint_head': commit,
             'protected_refs': protected, 'remote_digest': digest}
    state_path = common / 'fix-code' / (identity + '.json')
    save_state(state_path, state)
    return check(state_path)


def bootstrap(repo, name, destination=None):
    repo = Path(repo).expanduser().resolve()
    if repo.exists() and (not repo.is_dir() or any(repo.iterdir())):
        raise GuardError('Bootstrap requires a new or empty directory.')
    # Avoid accidental nested repositories; use a separate destination.
    ancestor = repo.parent
    while not ancestor.exists() and ancestor != ancestor.parent:
        ancestor = ancestor.parent
    if git(ancestor, 'rev-parse', '--show-toplevel', optional=True):
        raise GuardError('Bootstrap destination is inside an existing repository; choose a separate directory.')
    repo.mkdir(parents=True, exist_ok=True)
    git(repo, 'init', '--initial-branch=fix-code/base')
    git(repo, 'commit', '--allow-empty', '-m', 'Initialize non-main baseline for first pull request')
    return start(repo, name, 'refs/heads/fix-code/base', destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ['start', 'bootstrap']:
        command = commands.add_parser(name)
        command.add_argument('--repo', required=True)
        command.add_argument('--name', required=True)
        command.add_argument('--worktree')
        if name == 'start':
            command.add_argument('--base')
            command.add_argument('--protect', action='append', default=[])
    command = commands.add_parser('check')
    command.add_argument('--state', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'check':
            output = check(args.state)
        elif args.command == 'bootstrap':
            output = bootstrap(args.repo, args.name, args.worktree)
        else:
            output = start(args.repo, args.name, args.base, args.worktree, args.protect)
        print(json.dumps(output, indent=2))
        return 0
    except (GuardError, OSError, KeyError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
