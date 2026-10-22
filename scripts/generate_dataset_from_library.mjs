import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { spawn } from 'child_process';

const libraryPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Manga Index', 'library');

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

async function renderPdfPages(pdfPath, outDir) {
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const standardFontDataUrl = `file://${path.resolve('node_modules/pdfjs-dist/standard_fonts')}/`;
  
  const loadingTask = pdfjs.getDocument({
    data,
    standardFontDataUrl
  });
  
  const pdfDoc = await loadingTask.promise;
  console.log(`Rendering ${pdfDoc.numPages} pages from ${path.basename(pdfPath)}...`);

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    // Render at 2.0x scale for crisp images suitable for deep learning
    const viewport = page.getViewport({ scale: 2.0 });
    
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    
    await page.render({
      canvasContext: context,
      viewport: viewport
    }).promise;

    const pageName = `page-${String(pageNum).padStart(3, '0')}.png`;
    fs.writeFileSync(path.join(outDir, pageName), canvas.toBuffer('image/png'));
    process.stdout.write(`.`);
  }
  console.log(`\nDone! Saved rendered images to ${outDir}`);
}

async function runPythonAutoLabel(origDir, transDir, outputDatasetDir) {
  return new Promise((resolve, reject) => {
    const pythonBin = path.join('.venv', 'Scripts', 'python.exe');
    const pythonExe = fs.existsSync(pythonBin) ? pythonBin : 'python';
    
    const args = [
      'scripts/auto_label_difference.py',
      '--orig', origDir,
      '--trans', transDir,
      '--out', outputDatasetDir,
      '--min-area', '150',
      '--max-pct', '0.4',
      '--dilate', '10'
    ];

    console.log(`\nRunning difference-based auto-labeler...`);
    console.log(`Command: ${pythonExe} ${args.join(' ')}`);

    const proc = spawn(pythonExe, args, { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Python script exited with code ${code}`));
      }
    });
  });
}

async function main() {
  try {
    if (!fs.existsSync(libraryPath)) {
      console.error(`Error: Library directory not found at: ${libraryPath}`);
      console.error("Please make sure you have translated at least one chapter using the app.");
      process.exit(1);
    }

    const folders = fs.readdirSync(libraryPath);
    const chapters = [];

    for (const id of folders) {
      try {
        const metaPath = path.join(libraryPath, id, 'meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          chapters.push({
            id,
            title: meta.title,
            pageCount: meta.pageCount,
            originalPdf: path.join(libraryPath, id, 'original.pdf'),
            translatedPdf: path.join(libraryPath, id, 'translated.pdf')
          });
        }
      } catch (e) {
        // Skip invalid/incomplete folder
      }
    }

    if (chapters.length === 0) {
      console.error("No translated chapters found in your Library. Open the app and translate a PDF first!");
      process.exit(1);
    }

    let selectedChapter = null;

    // Check if an ID was passed in arguments
    const argId = process.argv[2];
    if (argId) {
      selectedChapter = chapters.find(c => c.id === argId);
      if (!selectedChapter) {
        console.error(`Could not find chapter with ID: ${argId}`);
      }
    }

    if (!selectedChapter) {
      console.log("\n--- CHOOSE A CHAPTER FROM YOUR LIBRARY TO GENERATE THE DATASET ---\n");
      chapters.forEach((c, index) => {
        console.log(`[${index + 1}] ${c.title} (${c.pageCount} pages)`);
      });
      console.log("");

      const answer = await askQuestion("Enter the number of the chapter you want to use: ");
      const idx = parseInt(answer, 10) - 1;

      if (isNaN(idx) || idx < 0 || idx >= chapters.length) {
        console.error("Invalid choice. Exiting.");
        process.exit(1);
      }
      selectedChapter = chapters[idx];
    }

    console.log(`\nSelected: ${selectedChapter.title}`);

    const tempOrigDir = path.resolve('temp_orig_dataset_images');
    const tempTransDir = path.resolve('temp_trans_dataset_images');
    const datasetOutputDir = path.resolve('models/yolo_dataset');

    // 1. Render Original PDF Pages
    console.log("\n[1/3] Processing original pages...");
    await renderPdfPages(selectedChapter.originalPdf, tempOrigDir);

    // 2. Render Translated PDF Pages
    console.log("\n[2/3] Processing translated pages...");
    await renderPdfPages(selectedChapter.translatedPdf, tempTransDir);

    // 3. Run YOLO dataset auto-labeling script
    console.log("\n[3/3] Generating YOLO annotations...");
    await runPythonAutoLabel(tempOrigDir, tempTransDir, datasetOutputDir);

    // 4. Cleanup
    console.log("\nCleaning up temporary files...");
    fs.rmSync(tempOrigDir, { recursive: true, force: true });
    fs.rmSync(tempTransDir, { recursive: true, force: true });

    console.log("\n=======================================================");
    console.log("SUCCESS: Dataset prepared successfully with 1 chapter!");
    console.log(`Output folder: ${datasetOutputDir}`);
    console.log(`Now you can start training your model using the Admin interface.`);
    console.log("=======================================================\n");

  } catch (err) {
    console.error("An error occurred during dataset generation:", err);
  }
}

main();
