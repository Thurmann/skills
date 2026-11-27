#!/usr/bin/env python3
"""Create isolated task branches and detect protected-ref/history changes.

This is an explicit checkpoint helper, not a hook or enforcement sandbox.
Only `finish` pushes, and only the task branch to an explicit
`refs/heads/<task-branch>` refspec. No command rebases, resets, or amends.
Commands never change the original checkout, except `start --in-place`,
`relocate`, `restore`, and `finish`, which may switch its branch, and only when
its tracked files are clean.
Bootstrap initializes only a new empty repository with an empty main baseline.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
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


def git_paths(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    if result.returncode:
        raise GuardError('Git command failed: ' + args[0] +
                         ' (exit ' + str(result.returncode) + '). Inspect locally.')
    return [item.decode('utf-8', 'surrogateescape')
            for item in result.stdout.split(b'\0') if item]


def root_of(repo):
    return Path(git(repo, 'rev-parse', '--show-toplevel')).resolve()


def common_of(repo):
    path = Path(git(repo, 'rev-parse', '--git-common-dir'))
    return (path if path.is_absolute() else Path(repo) / path).resolve()


def ref_tip(repo, ref):
    return git(repo, 'rev-parse', '--verify', ref, optional=True)


REMOTE_DIGEST_PATTERNS = {
    # Version 1: remote URLs only (states written before version 2).
    1: r'^remote\..*\.(url|pushurl)$',
    # Version 2: also config that can silently reroute a push.
    2: r'^(remote\..*\.(url|pushurl)|remote\.pushdefault|url\..*\.(insteadof|pushinsteadof)|branch\..*\.pushremote)$',
}


def remote_digest(repo, version=2):
    if version not in REMOTE_DIGEST_PATTERNS:
        raise GuardError('Unsupported remote digest version.')
    config = git(repo, 'config', '--get-regexp', REMOTE_DIGEST_PATTERNS[version],
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


def load_state(state_path):
    try:
        return json.loads(state_path.read_text())
    except (OSError, ValueError) as error:
        raise GuardError('Cannot read guard state.') from error


def ensure_no_unfinished_operation(worktree):
    for marker in ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']:
        marker_path = Path(git(worktree, 'rev-parse', '--git-path', marker))
        if not marker_path.is_absolute():
            marker_path = worktree / marker_path
        if marker_path.exists():
            raise GuardError('An unfinished Git operation is present: ' + marker)


def ensure_clean_tracked(repo, advice):
    if git(repo, 'status', '--porcelain', '--untracked-files=no'):
        raise GuardError('The checkout has staged or unstaged changes to tracked files; ' + advice)


def ensure_switch_safe(repo, from_commit, to_commit, advice):
    """Refuse a switch that could overwrite or delete untracked or ignored files."""
    changed = git_paths(repo, 'diff', '--name-only', '--no-renames', '-z',
                        from_commit, to_commit)
    if not changed:
        return
    # No exclude flags: ignored files are included, since a switch overwrites them silently.
    # Compare case-folded paths: on case-insensitive filesystems (macOS, Windows defaults)
    # a path differing only in case is the same file. Elsewhere this only refuses more.
    untracked = {path.casefold() for path in git_paths(repo, 'ls-files', '--others', '-z')}
    untracked_dirs = {parent for path in untracked
                      for parent in map(str, PurePosixPath(path).parents) if parent != '.'}
    for path in (path.casefold() for path in changed):
        parents = {str(parent) for parent in PurePosixPath(path).parents}
        if path in untracked or path in untracked_dirs or parents & untracked:
            raise GuardError('The branch switch would overwrite or remove untracked or '
                             'ignored files in the checkout; ' + advice)


def check(state_path):
    state_path = Path(state_path).expanduser().resolve()
    state = load_state(state_path)
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
    if remote_digest(worktree, state.get('remote_digest_version', 1)) != state['remote_digest']:
        raise GuardError('Remote routing configuration changed; validate the delivery target before proceeding.')
    ensure_no_unfinished_operation(worktree)
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


def plan_worktree(repo, worktree_name, destination):
    worktree = (Path(destination).expanduser().resolve() if destination else
                Path.home() / 'workspace' / 'worktrees' / repo.name / worktree_name)
    if worktree.exists():
        raise GuardError('Worktree destination exists; no files were replaced.')
    if worktree == repo or repo in worktree.parents or worktree in repo.parents:
        raise GuardError('Worktree destination must be outside and separate from the original repository.')
    return worktree


def ensure_in_place_ready(repo, common):
    advice = 'start a worktree task instead.'
    if Path(git(repo, 'rev-parse', '--absolute-git-dir')).resolve() != common:
        raise GuardError('In-place start requires the main checkout root; ' + advice)
    ensure_clean_tracked(repo, advice)
    try:
        ensure_no_unfinished_operation(repo)
    except GuardError as error:
        raise GuardError(str(error) + '; ' + advice) from error


def untracked_now(repo):
    return sorted(git_paths(repo, 'ls-files', '--others', '--exclude-standard', '-z'))


def switch_back(repo, branch, head):
    if branch:
        git(repo, 'switch', branch, optional=True)
    else:
        git(repo, 'switch', '--detach', head, optional=True)


def start(repo, name, requested_base=None, destination=None, protect=(), in_place=False):
    if in_place and destination:
        raise GuardError('--in-place and --worktree are mutually exclusive.')
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
    digest = remote_digest(repo)
    extra = {'in_place': in_place}
    if in_place:
        ensure_in_place_ready(repo, common)
        extra['original_branch'] = git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD',
                                       optional=True)
        extra['original_head'] = git(repo, 'rev-parse', '--verify', 'HEAD')
        extra['untracked_at_start'] = untracked_now(repo)
        ensure_switch_safe(repo, 'HEAD', commit, 'use a worktree start instead.')
        worktree = repo
        git(repo, 'switch', '-c', branch, commit)
    else:
        worktree = plan_worktree(repo, worktree_name, destination)
        worktree.parent.mkdir(parents=True, exist_ok=True)
        git(repo, 'worktree', 'add', '-b', branch, str(worktree), commit)
    state = {'version': 1, 'original_repo': str(repo), 'git_common_dir': str(common),
             'worktree': str(worktree), 'branch': branch, 'base_ref': base,
             'base_commit': commit, 'checkpoint_head': commit,
             'protected_refs': protected, 'remote_digest': digest,
             'remote_digest_version': 2, **extra}
    state_path = common / 'fix-code' / (identity + '.json')
    try:
        save_state(state_path, state)
    except BaseException:
        if in_place:
            switch_back(repo, extra['original_branch'], extra['original_head'])
        raise
    return check(state_path)


def load_in_place_state(state_path):
    check(state_path)  # Also refreshes the checkpoint; reload afterwards.
    state_path = Path(state_path).expanduser().resolve()
    state = load_state(state_path)
    if not state.get('in_place'):
        raise GuardError('State is not an in-place task; nothing to move.')
    repo = Path(state['worktree'])
    ensure_clean_tracked(repo, 'commit the work first.')
    recorded = state.get('untracked_at_start')
    if recorded is not None and set(untracked_now(repo)) - set(recorded):
        raise GuardError('The checkout has new untracked task files; '
                         'commit or remove new task files first.')
    return state_path, state, repo


def original_target(repo, state):
    branch = state.get('original_branch')
    target = ref_tip(repo, 'refs/heads/' + branch) if branch else state['original_head']
    if not target:
        raise GuardError('The original branch no longer exists; nothing was switched.')
    return target


def switch_to_original(repo, state):
    branch = state.get('original_branch')
    target = original_target(repo, state)
    ensure_switch_safe(repo, 'HEAD', target,
                       'move or remove those files, then retry.')
    if branch:
        git(repo, 'switch', branch)
    else:
        git(repo, 'switch', '--detach', state['original_head'])


def relocate_restored(state_path, state, destination):
    original = Path(state['original_repo'])
    if str(common_of(original)) != state['git_common_dir']:
        raise GuardError('Original checkout belongs to a different repository.')
    if not ref_tip(original, 'refs/heads/' + state['branch']):
        raise GuardError('The task branch no longer exists.')
    name = 'fix-code-' + state['branch'].split('/', 1)[-1]
    worktree = plan_worktree(original, name, destination)
    worktree.parent.mkdir(parents=True, exist_ok=True)
    git(original, 'worktree', 'add', str(worktree), state['branch'])
    state.update(worktree=str(worktree), in_place=False, restored=False,
                 relocated_from=str(original))
    save_state(state_path, state)
    return check(state_path)


def relocate(state_path, destination=None):
    resolved = Path(state_path).expanduser().resolve()
    state = load_state(resolved)
    if state.get('restored') and not state.get('in_place'):
        return relocate_restored(resolved, state, destination)
    state_path, state, repo = load_in_place_state(state_path)
    original = Path(state['original_repo'])
    name = 'fix-code-' + state['branch'].split('/', 1)[-1]
    worktree = plan_worktree(original, name, destination)  # Validate before switching.
    switch_to_original(repo, state)
    try:
        worktree.parent.mkdir(parents=True, exist_ok=True)
        git(repo, 'worktree', 'add', str(worktree), state['branch'])
    except (GuardError, OSError):
        git(repo, 'switch', state['branch'])
        raise
    state.update(worktree=str(worktree), in_place=False, relocated_from=str(repo))
    save_state(state_path, state)
    return check(state_path)


def restore(state_path):
    state_path, state, repo = load_in_place_state(state_path)
    switch_to_original(repo, state)
    state.update(in_place=False, restored=True)
    save_state(state_path, state)
    return {'ok': True, 'restored': True, 'branch': state['branch'],
            'checkout_branch': git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD',
                                   optional=True)}


def finish(state_path, remote='origin'):
    resolved = Path(state_path).expanduser().resolve()
    state = load_state(resolved)
    if not state.get('in_place'):
        raise GuardError('finish is only for in-place tasks; push worktree tasks explicitly.')
    if (not remote or remote.startswith('-') or
            git(Path(state['worktree']), 'remote', 'get-url', remote, optional=True) is None):
        raise GuardError('Unknown remote: ' + remote)
    state_path, state, repo = load_in_place_state(resolved)
    head = git(repo, 'rev-parse', '--verify', 'HEAD')
    # Verify the switch back is possible before anything is pushed.
    ensure_switch_safe(repo, 'HEAD', original_target(repo, state),
                       'move or remove those files, then retry.')
    git(repo, 'push', '-u', remote, 'HEAD:refs/heads/' + state['branch'])
    switch_to_original(repo, state)
    state.update(in_place=False, restored=True, pushed_remote=remote, pushed_head=head)
    save_state(state_path, state)
    return {'ok': True, 'pushed': 'refs/heads/' + state['branch'], 'remote': remote,
            'head': head, 'restored': True, 'branch': state['branch'],
            'checkout_branch': git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD',
                                   optional=True)}


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
    git(repo, 'init', '--initial-branch=main')
    git(repo, 'commit', '--allow-empty', '-m', 'Initialize main baseline for first pull request')
    return start(repo, name, 'refs/heads/main', destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ['start', 'bootstrap']:
        command = commands.add_parser(name)
        command.add_argument('--repo', required=True)
        command.add_argument('--name', required=True)
        command.add_argument('--worktree')
        if name == 'start':
            command.add_argument('--in-place', action='store_true')
            command.add_argument('--base')
            command.add_argument('--protect', action='append', default=[])
    for name in ['check', 'relocate', 'restore']:
        command = commands.add_parser(name)
        command.add_argument('--state', required=True)
        if name == 'relocate':
            command.add_argument('--worktree')
    finish_command = commands.add_parser('finish')
    finish_command.add_argument('--state', required=True)
    finish_command.add_argument('--remote', default='origin')
    args = parser.parse_args()
    try:
        if args.command == 'check':
            output = check(args.state)
        elif args.command == 'relocate':
            output = relocate(args.state, args.worktree)
        elif args.command == 'restore':
            output = restore(args.state)
        elif args.command == 'finish':
            output = finish(args.state, args.remote)
        elif args.command == 'bootstrap':
            output = bootstrap(args.repo, args.name, args.worktree)
        else:
            output = start(args.repo, args.name, args.base, args.worktree, args.protect,
                           args.in_place)
        print(json.dumps(output, indent=2))
        return 0
    except (GuardError, OSError, KeyError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
