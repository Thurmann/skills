#!/usr/bin/env python3
"""Exercise Git safety invariants in disposable repositories; no network calls."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

GUARD = Path(__file__).with_name('git_guard.py')


class GitGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='fix-code-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = dict(os.environ)
        for key in list(self.env):
            if key.startswith('GIT_'):
                del self.env[key]
        self.env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=str(self.root/'empty-config'),
                        GIT_AUTHOR_NAME='Fixture Author', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                        GIT_COMMITTER_NAME='Fixture Author', GIT_COMMITTER_EMAIL='fixture@example.invalid')
        (self.root/'empty-config').write_text('')
        self.repo = self.root/'source'
        self.repo.mkdir()
        self.start_count = 0
        self.git(self.repo, 'init', '--initial-branch=main')
        (self.repo/'app.txt').write_text('original\n')
        self.git(self.repo, 'add', 'app.txt')
        self.git(self.repo, 'commit', '-m', 'Fixture base')

    def command(self, args, expected=0):
        result = subprocess.run(args, env=self.env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, expected,
                         msg='Command failed: '+repr(args)+'\n'+result.stdout+result.stderr)
        return result

    def git(self, repo, *args):
        return self.command(['git', '-C', str(repo), *args]).stdout.strip()

    def guard(self, *args, expected=0):
        result = self.command([sys.executable, str(GUARD), *map(str, args)], expected)
        return json.loads(result.stdout if expected == 0 else result.stderr)

    def start(self, **kwargs):
        args = ['start', '--repo', self.repo, '--name', 'fixture change', '--base', 'main']
        if 'worktree' not in kwargs:
            self.start_count += 1
            kwargs['worktree'] = str(self.root/'worktrees'/str(self.start_count))
        for key, value in kwargs.items():
            args += ['--'+key, value]
        return self.guard(*args)

    def task_commit(self, state):
        worktree = Path(state['worktree'])
        (worktree/'feature.txt').write_text('task-owned\n')
        self.git(worktree, 'add', 'feature.txt')
        self.git(worktree, 'commit', '-m', 'Implement fixture change')
        return worktree

    def test_isolates_dirty_checkout_and_protects_main(self):
        main = self.git(self.repo, 'rev-parse', 'main')
        (self.repo/'app.txt').write_text('user edits\n')
        (self.repo/'personal.txt').write_text('untracked user work\n')
        before = self.git(self.repo, 'status', '--porcelain')
        state = self.start()
        worktree = self.task_commit(state)
        self.guard('check', '--state', state['state'])
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), 'main')
        self.assertEqual(self.git(self.repo, 'rev-parse', 'main'), main)
        self.assertEqual(self.git(self.repo, 'status', '--porcelain'), before)
        self.assertEqual((worktree/'app.txt').read_text(), 'original\n')
        self.assertFalse((worktree/'personal.txt').exists())

    def test_each_task_gets_fresh_branch_and_worktree(self):
        first, second = self.start(), self.start()
        self.assertNotEqual(first['branch'], second['branch'])
        self.assertNotEqual(first['worktree'], second['worktree'])

    def test_refuses_worktree_inside_original_checkout(self):
        destination = self.repo/'fix-code-fixture-unique'
        result = self.guard('start', '--repo', self.repo, '--name', 'fixture',
                            '--base', 'main', '--worktree', destination, expected=2)
        self.assertIn('outside and separate', result['error'])
        self.assertFalse(destination.exists())
        self.assertEqual(self.git(self.repo, 'status', '--porcelain'), '')

    def test_refuses_existing_destination_without_overwriting(self):
        existing = self.root/'existing'
        existing.mkdir()
        (existing/'keep.txt').write_text('keep')
        result = self.guard('start', '--repo', self.repo, '--name', 'test',
                            '--base', 'main', '--worktree', existing, expected=2)
        self.assertIn('exists', result['error'])
        self.assertEqual((existing/'keep.txt').read_text(), 'keep')

    def test_detects_wrong_branch(self):
        state = self.start()
        self.git(state['worktree'], 'switch', '--detach')
        self.assertIn('wrong branch', self.guard('check', '--state', state['state'], expected=2)['error'])

    def test_detects_protected_ref_change(self):
        state = self.start()
        worktree = self.task_commit(state)
        changed = self.git(worktree, 'rev-parse', 'HEAD')
        self.git(self.repo, 'update-ref', 'refs/heads/main', changed)
        self.assertIn('Protected ref changed', self.guard('check', '--state', state['state'], expected=2)['error'])

    def test_detects_rewrite_after_checkpoint(self):
        state = self.start()
        worktree = self.task_commit(state)
        self.guard('check', '--state', state['state'])
        # Deliberate violation in a disposable fixture to test detection.
        self.git(worktree, 'commit', '--amend', '-m', 'Rewritten fixture commit')
        self.assertIn('history rewrite', self.guard('check', '--state', state['state'], expected=2)['error'])

    def test_detects_remote_rerouting(self):
        self.git(self.repo, 'remote', 'add', 'origin', 'https://example.invalid/expected.git')
        state = self.start()
        self.git(self.repo, 'remote', 'set-url', 'origin', 'https://example.invalid/other.git')
        self.assertIn('routing', self.guard('check', '--state', state['state'], expected=2)['error'])

    def test_detects_unfinished_merge(self):
        state = self.start()
        worktree = Path(state['worktree'])
        marker = Path(self.git(worktree, 'rev-parse', '--git-path', 'MERGE_HEAD'))
        if not marker.is_absolute():
            marker = worktree/marker
        marker.write_text(state['head']+'\n')
        self.assertIn('unfinished Git operation', self.guard('check', '--state', state['state'], expected=2)['error'])

    def test_protects_nonstandard_default(self):
        self.git(self.repo, 'branch', 'release')
        self.git(self.repo, 'update-ref', 'refs/remotes/origin/release', 'HEAD')
        self.git(self.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release')
        state = self.guard('start', '--repo', self.repo, '--name', 'test',
                           '--worktree', self.root/'worktrees'/'nonstandard-default')
        worktree = self.task_commit(state)
        self.git(self.repo, 'update-ref', 'refs/heads/release', self.git(worktree, 'rev-parse', 'HEAD'))
        self.assertIn('release', self.guard('check', '--state', state['state'], expected=2)['error'])

    def test_bootstraps_main_default_and_isolates_implementation(self):
        empty = self.root/'new-project'
        state = self.guard('bootstrap', '--repo', empty, '--name', 'first implementation',
                           '--worktree', self.root/'worktrees'/'bootstrap')
        baseline = self.git(empty, 'rev-parse', 'refs/heads/main')
        self.assertEqual(self.git(empty, 'symbolic-ref', '--short', 'HEAD'), 'main')
        self.assertEqual(state['base'], 'refs/heads/main')
        self.assertEqual(self.git(empty, 'ls-tree', '--name-only', 'main'), '')
        self.assertEqual(self.git(empty, 'rev-list', '--count', 'main'), '1')
        self.assertNotEqual(state['branch'], 'main')
        self.task_commit(state)
        self.guard('check', '--state', state['state'])
        self.assertEqual(self.git(empty, 'rev-parse', 'main'), baseline)
        self.assertEqual(self.git(empty, 'status', '--porcelain'), '')
        branches = self.git(empty, 'for-each-ref', '--format=%(refname)', 'refs/heads').splitlines()
        self.assertIn('refs/heads/main', branches)
        self.assertNotIn('refs/heads/fix-code/base', branches)
        self.git(state['worktree'], 'merge-base', '--is-ancestor', 'main', 'HEAD')

    def test_bootstrap_main_is_protected_after_initialization(self):
        empty = self.root/'new-project'
        state = self.guard('bootstrap', '--repo', empty, '--name', 'first implementation',
                           '--worktree', self.root/'worktrees'/'bootstrap-protection')
        worktree = self.task_commit(state)
        # Deliberate violation in a disposable fixture, never a user repository.
        self.git(empty, 'update-ref', 'refs/heads/main', self.git(worktree, 'rev-parse', 'HEAD'))
        result = self.guard('check', '--state', state['state'], expected=2)
        self.assertIn('Protected ref changed: refs/heads/main', result['error'])

    def test_bootstrap_refuses_nonempty_directory(self):
        target = self.root/'not-empty'
        target.mkdir()
        (target/'existing.txt').write_text('keep')
        self.guard('bootstrap', '--repo', target, '--name', 'no', expected=2)
        self.assertFalse((target/'.git').exists())
        self.assertEqual((target/'existing.txt').read_text(), 'keep')

    def test_missing_protected_branch_cannot_be_created(self):
        state = self.start()
        self.git(self.repo, 'branch', 'trunk')
        self.assertIn('trunk', self.guard('check', '--state', state['state'], expected=2)['error'])

    def start_in_place(self, *extra):
        return self.guard('start', '--repo', self.repo, '--name', 'fixture change',
                          '--base', 'main', '--in-place', *extra)

    def commit_in(self, path):
        (Path(path)/'feature.txt').write_text('task-owned\n')
        self.git(path, 'add', 'feature.txt')
        self.git(path, 'commit', '-m', 'Implement fixture change')

    def branches(self):
        return self.git(self.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads')

    def test_in_place_start_creates_fresh_branch_in_checkout(self):
        main = self.git(self.repo, 'rev-parse', 'main')
        state = self.start_in_place()
        self.assertEqual(Path(state['worktree']), self.repo.resolve())
        self.assertNotEqual(state['branch'], 'main')
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), state['branch'])
        saved = json.loads(Path(state['state']).read_text())
        self.assertTrue(saved['in_place'])
        self.assertEqual(saved['original_branch'], 'main')
        self.assertEqual(saved['original_head'], main)
        self.commit_in(self.repo)
        self.guard('check', '--state', state['state'])
        self.assertEqual(self.git(self.repo, 'rev-parse', 'main'), main)

    def test_worktree_start_records_not_in_place(self):
        state = self.start()
        self.assertFalse(json.loads(Path(state['state']).read_text())['in_place'])

    def test_in_place_refuses_dirty_tracked_changes(self):
        (self.repo/'app.txt').write_text('user edits\n')
        before = self.branches()
        head = self.git(self.repo, 'rev-parse', 'HEAD')
        result = self.guard('start', '--repo', self.repo, '--name', 'x', '--base', 'main',
                            '--in-place', expected=2)
        self.assertIn('worktree', result['error'])
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), 'main')
        self.assertEqual(self.git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertEqual(self.branches(), before)
        self.assertEqual((self.repo/'app.txt').read_text(), 'user edits\n')

    def test_in_place_allows_and_preserves_untracked_files(self):
        (self.repo/'personal.txt').write_text('mine\n')
        state = self.start_in_place()
        self.assertEqual((self.repo/'personal.txt').read_text(), 'mine\n')
        self.guard('check', '--state', state['state'])

    def test_in_place_refuses_unfinished_merge(self):
        marker = Path(self.git(self.repo, 'rev-parse', '--absolute-git-dir'))/'MERGE_HEAD'
        marker.write_text(self.git(self.repo, 'rev-parse', 'HEAD')+'\n')
        before = self.branches()
        result = self.guard('start', '--repo', self.repo, '--name', 'x', '--base', 'main',
                            '--in-place', expected=2)
        self.assertIn('unfinished Git operation', result['error'])
        self.assertEqual(self.branches(), before)

    def test_in_place_refuses_linked_worktree(self):
        state = self.start()
        result = self.guard('start', '--repo', state['worktree'], '--name', 'x',
                            '--base', 'main', '--in-place', expected=2)
        self.assertIn('main checkout', result['error'])

    def test_in_place_conflicts_with_worktree(self):
        before = self.branches()
        result = self.guard('start', '--repo', self.repo, '--name', 'x', '--base', 'main',
                            '--in-place', '--worktree', self.root/'worktrees'/'both', expected=2)
        self.assertIn('mutually exclusive', result['error'])
        self.assertEqual(self.branches(), before)
        self.assertFalse((self.root/'worktrees'/'both').exists())

    def test_in_place_detects_protected_ref_change(self):
        state = self.start_in_place()
        self.commit_in(self.repo)
        self.git(self.repo, 'update-ref', 'refs/heads/main', self.git(self.repo, 'rev-parse', 'HEAD'))
        self.assertIn('Protected ref changed', self.guard('check', '--state', state['state'], expected=2)['error'])

    def test_relocate_moves_task_to_worktree(self):
        state = self.start_in_place()
        self.commit_in(self.repo)
        destination = self.root/'worktrees'/'relocated'
        moved = self.guard('relocate', '--state', state['state'], '--worktree', destination)
        self.assertEqual(Path(moved['worktree']), destination.resolve())
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), 'main')
        self.assertEqual(self.git(destination, 'branch', '--show-current'), state['branch'])
        self.assertEqual((destination/'feature.txt').read_text(), 'task-owned\n')
        saved = json.loads(Path(state['state']).read_text())
        self.assertFalse(saved['in_place'])
        self.assertEqual(Path(saved['relocated_from']), self.repo.resolve())
        self.guard('check', '--state', state['state'])

    def test_relocate_refuses_dirty_checkout(self):
        state = self.start_in_place()
        (self.repo/'app.txt').write_text('uncommitted\n')
        destination = self.root/'worktrees'/'dirty'
        result = self.guard('relocate', '--state', state['state'], '--worktree', destination, expected=2)
        self.assertIn('commit', result['error'])
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), state['branch'])
        self.assertFalse(destination.exists())

    def test_relocate_refuses_worktree_state(self):
        state = self.start()
        result = self.guard('relocate', '--state', state['state'],
                            '--worktree', self.root/'worktrees'/'nope', expected=2)
        self.assertIn('not an in-place', result['error'])

    def test_relocate_refuses_destination_inside_checkout_without_switching(self):
        state = self.start_in_place()
        self.commit_in(self.repo)
        destination = self.repo/'inside'
        result = self.guard('relocate', '--state', state['state'], '--worktree', destination, expected=2)
        self.assertIn('outside and separate', result['error'])
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), state['branch'])
        self.assertFalse(destination.exists())
        self.guard('check', '--state', state['state'])

    def test_restore_returns_checkout_to_original_branch(self):
        state = self.start_in_place()
        self.commit_in(self.repo)
        result = self.guard('restore', '--state', state['state'])
        self.assertEqual(result, {'ok': True, 'restored': True, 'branch': state['branch'],
                                  'checkout_branch': 'main'})
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), 'main')
        self.assertIn('refs/heads/'+state['branch'], self.branches())
        saved = json.loads(Path(state['state']).read_text())
        self.assertTrue(saved['restored'])
        self.assertIn('wrong branch', self.guard('check', '--state', state['state'], expected=2)['error'])

    def test_restore_returns_to_detached_original_head(self):
        head = self.git(self.repo, 'rev-parse', 'HEAD')
        self.git(self.repo, 'switch', '--detach')
        state = self.start_in_place()
        self.assertIsNone(json.loads(Path(state['state']).read_text())['original_branch'])
        self.commit_in(self.repo)
        result = self.guard('restore', '--state', state['state'])
        self.assertIsNone(result['checkout_branch'])
        self.assertEqual(self.git(self.repo, 'rev-parse', 'HEAD'), head)
        self.assertIn('refs/heads/'+state['branch'], self.branches())

    def test_restore_refuses_dirty_and_worktree_states(self):
        state = self.start_in_place()
        (self.repo/'app.txt').write_text('uncommitted\n')
        self.guard('restore', '--state', state['state'], expected=2)
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), state['branch'])
        other = self.start()
        self.assertIn('not an in-place', self.guard('restore', '--state', other['state'], expected=2)['error'])

    def collision_setup(self):
        (self.repo/'secret.txt').write_text('base\n')
        self.git(self.repo, 'add', 'secret.txt')
        self.git(self.repo, 'commit', '-m', 'Track secret in base')
        self.git(self.repo, 'switch', '-c', 'user')
        self.git(self.repo, 'rm', '--cached', 'secret.txt')
        (self.repo/'.gitignore').write_text('secret.txt\n')
        self.git(self.repo, 'add', '.gitignore')
        self.git(self.repo, 'commit', '-m', 'Ignore secret')
        (self.repo/'secret.txt').write_text('precious\n')

    def test_in_place_refuses_ignored_file_colliding_with_base(self):
        self.collision_setup()
        before = self.branches()
        result = self.guard('start', '--repo', self.repo, '--name', 'x', '--base', 'main',
                            '--in-place', expected=2)
        self.assertIn('worktree', result['error'])
        self.assertNotIn('precious', result['error'])
        self.assertEqual((self.repo/'secret.txt').read_text(), 'precious\n')
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), 'user')
        self.assertEqual(self.branches(), before)

    def test_in_place_refuses_collision_differing_only_in_case(self):
        (self.repo/'Settings.local').write_text('base\n')
        self.git(self.repo, 'add', 'Settings.local')
        self.git(self.repo, 'commit', '-m', 'Track settings in base')
        self.git(self.repo, 'switch', '-c', 'user')
        self.git(self.repo, 'rm', '--quiet', 'Settings.local')
        (self.repo/'.gitignore').write_text('settings.local\n')
        self.git(self.repo, 'add', '.gitignore')
        self.git(self.repo, 'commit', '-m', 'Ignore local settings')
        (self.repo/'settings.local').write_text('mine\n')
        before = self.branches()
        result = self.guard('start', '--repo', self.repo, '--name', 'x', '--base', 'main',
                            '--in-place', expected=2)
        self.assertIn('worktree', result['error'])
        self.assertEqual((self.repo/'settings.local').read_text(), 'mine\n')
        self.assertEqual(self.branches(), before)

    def test_in_place_from_other_branch_restores_to_it(self):
        self.git(self.repo, 'switch', '-c', 'dev')
        (self.repo/'dev.txt').write_text('dev\n')
        self.git(self.repo, 'add', 'dev.txt')
        self.git(self.repo, 'commit', '-m', 'Dev work')
        dev = self.git(self.repo, 'rev-parse', 'dev')
        state = self.start_in_place()
        self.assertFalse((self.repo/'dev.txt').exists())
        self.commit_in(self.repo)
        self.guard('restore', '--state', state['state'])
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), 'dev')
        self.assertEqual(self.git(self.repo, 'rev-parse', 'dev'), dev)

    def test_restore_refuses_ignored_file_collision(self):
        state = self.start_in_place()
        self.git(self.repo, 'rm', 'app.txt')
        (self.repo/'.gitignore').write_text('app.txt\n')
        self.git(self.repo, 'add', '.gitignore')
        self.git(self.repo, 'commit', '-m', 'Drop app, ignore it')
        (self.repo/'app.txt').write_text('precious\n')
        result = self.guard('restore', '--state', state['state'], expected=2)
        self.assertNotIn('precious', result['error'])
        self.assertEqual((self.repo/'app.txt').read_text(), 'precious\n')
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), state['branch'])

    def test_relocate_refuses_untracked_path_under_target_file(self):
        state = self.start_in_place()
        self.git(self.repo, 'rm', 'app.txt')
        (self.repo/'app.txt').mkdir()
        (self.repo/'app.txt'/'x').write_text('precious\n')
        (self.repo/'.gitignore').write_text('app.txt/\n')
        self.git(self.repo, 'add', '.gitignore')
        self.git(self.repo, 'commit', '-m', 'Replace file by ignored dir')
        self.guard('relocate', '--state', state['state'],
                   '--worktree', self.root/'worktrees'/'rev', expected=2)
        self.assertEqual((self.repo/'app.txt'/'x').read_text(), 'precious\n')
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), state['branch'])

    def test_relocate_and_restore_refuse_new_task_files(self):
        (self.repo/'personal.txt').write_text('mine\n')
        state = self.start_in_place()
        self.commit_in(self.repo)
        (self.repo/'notes.txt').write_text('task notes\n')
        for args in (['relocate', '--worktree', self.root/'worktrees'/'new-files'], ['restore']):
            result = self.guard(*args[:1], '--state', state['state'], *args[1:], expected=2)
            self.assertIn('commit or remove new task files first', result['error'])
            self.assertEqual(self.git(self.repo, 'branch', '--show-current'), state['branch'])
        (self.repo/'notes.txt').unlink()
        self.guard('restore', '--state', state['state'])
        self.assertEqual((self.repo/'personal.txt').read_text(), 'mine\n')

    def test_relocate_after_restore_creates_worktree(self):
        state = self.start_in_place()
        self.commit_in(self.repo)
        self.guard('restore', '--state', state['state'])
        destination = self.root/'worktrees'/'after-restore'
        moved = self.guard('relocate', '--state', state['state'], '--worktree', destination)
        self.assertEqual(Path(moved['worktree']), destination.resolve())
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), 'main')
        self.assertEqual((destination/'feature.txt').read_text(), 'task-owned\n')
        saved = json.loads(Path(state['state']).read_text())
        self.assertFalse(saved['in_place'])
        self.assertFalse(saved['restored'])
        self.guard('check', '--state', state['state'])

    def test_relocate_rolls_back_when_worktree_add_fails(self):
        state = self.start_in_place()
        self.commit_in(self.repo)
        blocker = self.root/'blocker'
        blocker.write_text('file')
        self.guard('relocate', '--state', state['state'],
                   '--worktree', blocker/'wt', expected=2)
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), state['branch'])
        self.assertTrue(json.loads(Path(state['state']).read_text())['in_place'])
        self.guard('check', '--state', state['state'])

    def test_relocate_and_restore_refuse_deleted_original_branch(self):
        self.git(self.repo, 'switch', '-c', 'feature-x')
        for command in ('relocate', 'restore'):
            state = self.start_in_place()
            self.commit_in(self.repo)
            self.git(self.repo, 'branch', '-D', 'feature-x')
            args = ['--worktree', self.root/'worktrees'/'gone'] if command == 'relocate' else []
            result = self.guard(command, '--state', state['state'], *args, expected=2)
            self.assertIn('no longer exists', result['error'])
            self.assertEqual(self.git(self.repo, 'branch', '--show-current'), state['branch'])
            self.git(self.repo, 'branch', 'feature-x', 'main')
            self.git(self.repo, 'switch', 'feature-x')
            self.git(self.repo, 'branch', '-D', state['branch'])

    def add_bare_remote(self):
        self.git(self.root, 'init', '--bare', '--quiet', 'remote.git')
        remote = self.root/'remote.git'
        self.git(self.repo, 'remote', 'add', 'origin', str(remote))
        return remote

    def test_finish_pushes_only_task_branch_and_restores(self):
        remote = self.add_bare_remote()
        state = self.start_in_place()
        self.commit_in(self.repo)
        head = self.git(self.repo, 'rev-parse', 'HEAD')
        result = self.guard('finish', '--state', state['state'])
        branch = state['branch']
        self.assertEqual(self.git(remote, 'for-each-ref', '--format=%(refname)'),
                         'refs/heads/'+branch)
        self.assertEqual(self.git(remote, 'rev-parse', 'refs/heads/'+branch), head)
        self.assertEqual(self.git(self.repo, 'config', '--get', 'branch.'+branch+'.remote'), 'origin')
        self.assertEqual(self.git(self.repo, 'config', '--get', 'branch.'+branch+'.merge'),
                         'refs/heads/'+branch)
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), 'main')
        saved = json.loads(Path(state['state']).read_text())
        self.assertTrue(saved['restored'])
        self.assertFalse(saved['in_place'])
        self.assertEqual(result, {'ok': True, 'pushed': 'refs/heads/'+branch, 'remote': 'origin',
                                  'head': head, 'restored': True, 'branch': branch,
                                  'checkout_branch': 'main'})

    def test_finish_ignores_follow_tags_config(self):
        remote = self.add_bare_remote()
        self.git(self.repo, 'tag', '-a', 'v1', '-m', 'Fixture tag')
        self.git(self.repo, 'config', 'push.followTags', 'true')
        state = self.start_in_place()
        self.commit_in(self.repo)
        self.guard('finish', '--state', state['state'])
        self.assertEqual(self.git(remote, 'for-each-ref', '--format=%(refname)'),
                         'refs/heads/'+state['branch'])

    def test_finish_refuses_worktree_state(self):
        remote = self.add_bare_remote()
        state = self.start()
        self.task_commit(state)
        result = self.guard('finish', '--state', state['state'], expected=2)
        self.assertIn('finish is only for in-place tasks', result['error'])
        self.assertEqual(self.git(remote, 'for-each-ref', '--format=%(refname)'), '')

    def test_finish_refuses_dirty_tracked_changes(self):
        remote = self.add_bare_remote()
        state = self.start_in_place()
        self.commit_in(self.repo)
        (self.repo/'app.txt').write_text('uncommitted\n')
        result = self.guard('finish', '--state', state['state'], expected=2)
        self.assertIn('changes to tracked files', result['error'])
        self.assertEqual(self.git(remote, 'for-each-ref', '--format=%(refname)'), '')
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), state['branch'])

    def test_finish_refuses_unknown_or_option_like_remote(self):
        remote = self.add_bare_remote()
        state = self.start_in_place()
        self.commit_in(self.repo)
        for flag in ('--remote=nope', '--remote=-x', '--remote='):
            result = self.guard('finish', '--state', state['state'], flag, expected=2)
            self.assertIn('Unknown remote', result['error'])
            self.assertEqual(self.git(remote, 'for-each-ref', '--format=%(refname)'), '')
            self.assertEqual(self.git(self.repo, 'branch', '--show-current'), state['branch'])
        saved = json.loads(Path(state['state']).read_text())
        self.assertTrue(saved['in_place'])
        self.assertFalse(saved.get('restored', False))

    def test_check_detects_new_rerouting_config(self):
        keys = [
            lambda branch: ('url.https://example.invalid/.insteadOf', 'ssh://example.invalid/'),
            lambda branch: ('url.https://example.invalid/.pushInsteadOf', 'ssh://example.invalid/'),
            lambda branch: ('remote.pushDefault', 'origin'),
            lambda branch: ('branch.'+branch+'.pushRemote', 'origin'),
        ]
        for make in keys:
            state = self.start()
            key, value = make(state['branch'])
            with self.subTest(key=key):
                self.git(self.repo, 'config', key, value)
                error = self.guard('check', '--state', state['state'], expected=2)['error']
                self.assertIn('routing', error)
                self.git(self.repo, 'config', '--unset', key)

    def test_check_ignores_branch_upstream_from_push(self):
        remote = self.add_bare_remote()
        state = self.start_in_place()
        self.commit_in(self.repo)
        self.git(self.repo, 'push', '-u', 'origin', 'HEAD:refs/heads/'+state['branch'])
        self.guard('check', '--state', state['state'])

    def test_legacy_state_keeps_version_one_digest(self):
        remote = self.add_bare_remote()
        state = self.start()
        sys.path.insert(0, str(GUARD.parent))
        import git_guard
        saved = json.loads(Path(state['state']).read_text())
        saved.pop('remote_digest_version')
        saved['remote_digest'] = git_guard.remote_digest(state['worktree'], 1)
        Path(state['state']).write_text(json.dumps(saved))
        self.git(self.repo, 'config', 'url.https://example.invalid/.insteadOf', 'ssh://example.invalid/')
        self.guard('check', '--state', state['state'])
        self.git(self.repo, 'remote', 'set-url', 'origin', 'https://example.invalid/other.git')
        self.assertIn('routing', self.guard('check', '--state', state['state'], expected=2)['error'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
