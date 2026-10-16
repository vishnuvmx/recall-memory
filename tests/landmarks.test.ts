import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractLandmarks, scanLandmarks, formatLandmarksMarkdown } from '../src/core/landmarks.js';
import { scanProject } from '../src/core/mapper.js';
import { cleanup, tmpProject } from './helpers.js';

const dirs: string[] = [];
const mk = (): string => {
  const d = tmpProject();
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach(cleanup));

describe('landmarks', () => {
  it('extracts Dart classes, methods, and line numbers', () => {
    const dartCode = `
import 'package:flutter/material.dart';

class DocumentViewerScreen extends StatefulWidget {
  const DocumentViewerScreen({super.key});

  @override
  State<DocumentViewerScreen> createState() => _DocumentViewerScreenState();
}

class _DocumentViewerScreenState extends State<DocumentViewerScreen> {
  bool _isEditMode = false;

  @override
  Widget build(BuildContext context) {
    return Container();
  }

  void _toggleEditMode() {
    setState(() {
      _isEditMode = !_isEditMode;
    });
  }

  Future<void> _exportPdf() async {
    // export
  }

  void _showOptionsSheet() {
    // options
  }
}
`;
    const landmarks = extractLandmarks(dartCode, '.dart');
    const names = landmarks.map((l) => l.name);

    expect(names).toContain('DocumentViewerScreen');
    expect(names).toContain('_DocumentViewerScreenState');
    expect(names).toContain('build');
    expect(names).toContain('_toggleEditMode');
    expect(names).toContain('_exportPdf');
    expect(names).toContain('_showOptionsSheet');

    const toggle = landmarks.find((l) => l.name === '_toggleEditMode');
    expect(toggle?.line).toBeGreaterThan(15);
  });

  it('scans large files across project and formats markdown', () => {
    const root = mk();
    const libDir = path.join(root, 'lib', 'screens');
    fs.mkdirSync(libDir, { recursive: true });

    // Generate a 400-line mock Dart file
    const lines = [
      'class BigScreen {',
      '  void doSomething() {}',
    ];
    for (let i = 0; i < 350; i++) {
      lines.push(`  // dummy line ${i}`);
    }
    lines.push('  void handleSave() {}');
    lines.push('}');

    fs.writeFileSync(path.join(libDir, 'big_screen.dart'), lines.join('\n'));

    const scanned = scanLandmarks(root, 300);
    expect(scanned.length).toBe(1);
    expect(scanned[0]!.relativePath).toBe('lib/screens/big_screen.dart');
    expect(scanned[0]!.totalLines).toBeGreaterThan(300);

    const md = formatLandmarksMarkdown(scanned);
    expect(md).toContain('Large File Landmarks');
    expect(md).toContain('`lib/screens/big_screen.dart`');
    expect(md).toContain('`handleSave`');

    // Also verify scanProject includes landmarks
    const projData = scanProject(root);
    expect(projData.landmarks.length).toBe(1);
    expect(projData.projectType).toBe('Generic project');
  });

  it('extracts Kotlin classes, SDK objects, and functions', () => {
    const ktCode = `
package com.edita.tools.pdf

class EditaPdfSdk(private val context: Context) {
  fun initializeEngine() {
    // init
  }

  suspend fun renderPdfPage(pageIndex: Int): Bitmap {
    // render
  }

  private fun exportToPptx(file: File) {
    // pptx
  }
}
`;
    const landmarks = extractLandmarks(ktCode, '.kt');
    const names = landmarks.map((l) => l.name);
    expect(names).toContain('EditaPdfSdk');
    expect(names).toContain('initializeEngine');
    expect(names).toContain('renderPdfPage');
    expect(names).toContain('exportToPptx');
  });

  it('extracts TypeScript/JavaScript functions, methods with modifiers, and arrow types without TODO comments', () => {
    const tsCode = `
export abstract class BaseService {
  public async fetchData(): Promise<void> {
    // fetch
  }

  static createInstance(): BaseService {
    return null as any;
  }
}

// TODO: refactor this old function
export default function startWorker() {
  // worker
}

export const ButtonComponent: React.FC = () => {
  return null;
};

// MARK: Helper functions
const helper = async () => {};
`;
    const landmarks = extractLandmarks(tsCode, '.ts');
    const names = landmarks.map((l) => l.name);

    expect(names).toContain('BaseService');
    expect(names).toContain('fetchData');
    expect(names).toContain('createInstance');
    expect(names).toContain('startWorker');
    expect(names).toContain('ButtonComponent');
    expect(names).toContain('helper');
    expect(names).toContain('MARK: Helper functions');
    // Ensure generic TODO comments are NOT extracted as landmarks
    expect(names.some((n) => n.includes('TODO:'))).toBe(false);
  });

  it('extracts Python async functions and indented class methods', () => {
    const pyCode = `
class ServiceController:
    def __init__(self, config):
        self.config = config

    async def execute_task(self):
        pass

async def standalone_handler():
    pass
`;
    const landmarks = extractLandmarks(pyCode, '.py');
    const names = landmarks.map((l) => l.name);

    expect(names).toContain('ServiceController');
    expect(names).toContain('__init__');
    expect(names).toContain('execute_task');
    expect(names).toContain('standalone_handler');
  });

  it('extracts C#, C++, PHP, and Ruby landmarks', () => {
    const csCode = `
namespace MyApp;
public class AccountManager {
  public async Task ProcessPayment(string id) {}
}
`;
    const csLandmarks = extractLandmarks(csCode, '.cs');
    expect(csLandmarks.map((l) => l.name)).toContain('AccountManager');
    expect(csLandmarks.map((l) => l.name)).toContain('ProcessPayment');

    const cppCode = `
class EngineController {
  void initSubsystems() {
  }
};
`;
    const cppLandmarks = extractLandmarks(cppCode, '.cpp');
    expect(cppLandmarks.map((l) => l.name)).toContain('EngineController');
    expect(cppLandmarks.map((l) => l.name)).toContain('initSubsystems');

    const phpCode = `
<?php
class UserRepository {
  public function findById($id) {}
}
`;
    const phpLandmarks = extractLandmarks(phpCode, '.php');
    expect(phpLandmarks.map((l) => l.name)).toContain('UserRepository');
    expect(phpLandmarks.map((l) => l.name)).toContain('findById');

    const rbCode = `
module Auth
  class SessionManager
    def authenticate_user(token)
    end
  end
end
`;
    const rbLandmarks = extractLandmarks(rbCode, '.rb');
    expect(rbLandmarks.map((l) => l.name)).toContain('SessionManager');
    expect(rbLandmarks.map((l) => l.name)).toContain('authenticate_user');
  });
});
