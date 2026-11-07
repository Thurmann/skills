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

    def test_bootstraps_without_creating_main(self):
        empty = self.root/'new-project'
        state = self.guard('bootstrap', '--repo', empty, '--name', 'first implementation',
                           '--worktree', self.root/'worktrees'/'bootstrap')
        self.task_commit(state)
        self.guard('check', '--state', state['state'])
        branches = self.git(empty, 'for-each-ref', '--format=%(refname)', 'refs/heads')
        self.assertIn('refs/heads/fix-code/base', branches)
        self.assertNotIn('refs/heads/main\n', branches+'\n')
        self.git(state['worktree'], 'merge-base', '--is-ancestor', 'fix-code/base', 'HEAD')

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


if __name__ == '__main__':
    unittest.main(verbosity=2)
