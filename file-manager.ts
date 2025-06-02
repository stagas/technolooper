// Import idb-keyval for directory handle persistence
import { get, set } from 'idb-keyval'
import JSZip from 'jszip'
import type { Stem, StemKind } from './types.ts'

// Directory handle storage
let directoryHandle: FileSystemDirectoryHandle | null = null
const DIRECTORY_HANDLE_KEY = 'technolooper-directory-handle'

// Callback for when directory is loaded
let onDirectoryLoaded: ((handle: FileSystemDirectoryHandle) => void | Promise<void>) | null = null

async function selectDirectory(): Promise<void> {
  console.log('selectDirectory function called')

  try {
    // Check if File System Access API is supported
    if (!('showDirectoryPicker' in window)) {
      console.error('File System Access API is not supported in this browser')
      return
    }

    console.log('About to call window.showDirectoryPicker()')

    // Show directory picker
    const handle = await (window as any).showDirectoryPicker()
    directoryHandle = handle

    // Save directory handle to IndexedDB
    await set(DIRECTORY_HANDLE_KEY, handle)

    console.log('Directory selected:', handle.name)

    // Trigger directory loaded callback
    if (onDirectoryLoaded) {
      await onDirectoryLoaded(handle)
    }
  } catch (error) {
    if (error instanceof Error && error.name !== 'AbortError') {
      console.error('Error selecting directory:', error)
    } else {
      console.log('Directory selection was cancelled by user')
    }
  }
}

async function loadSavedDirectory(): Promise<boolean> {
  try {
    const savedHandle = await get(DIRECTORY_HANDLE_KEY)

    if (savedHandle) {
      // Verify we still have permission to access the directory
      const permission = await savedHandle.queryPermission({ mode: 'readwrite' })

      if (permission === 'granted' || permission === 'prompt') {
        directoryHandle = savedHandle
        console.log('Loaded saved directory:', savedHandle.name)

        // Trigger directory loaded callback
        if (onDirectoryLoaded) {
          await onDirectoryLoaded(savedHandle)
        }

        return true
      }
    }
  } catch (error) {
    console.log('No saved directory or error loading:', error)
  }

  return false
}

async function findZipFiles(dirHandle: FileSystemDirectoryHandle) {
  const zipFiles = []
  for await (const [name, handle] of dirHandle.entries()) {
    if (
      handle.kind === 'file'
      && name.endsWith('.zip')
      && name.includes('[Stems]')
    ) {
      zipFiles.push({ name, handle })
    }
  }

  // Sort ZIP files alphabetically by name for consistent ordering
  zipFiles.sort((a, b) => a.name.localeCompare(b.name))

  return zipFiles
}

async function readZipFileMetadata(dirHandle: FileSystemDirectoryHandle, fileName: string) {
  const fileHandle = await dirHandle.getFileHandle(fileName)
  const zipFile = await fileHandle.getFile()
  const arrayBuffer = await zipFile.arrayBuffer()

  const zip = new JSZip()
  const zipContent = await zip.loadAsync(arrayBuffer)

  // Extract metadata without decoding audio
  let stemMetadata: Array<{
    name: string
    bpm: number
    kind: StemKind
    fileName: string
    zipFile: JSZip.JSZipObject
  }> = []

  for (const file of Object.values(zipContent.files)) {
    if (file.dir) continue
    const name = file.name.split('/')[1].split(' - ').slice(2).join(' - ').replace('.wav', '')
    const bpm = Number(file.name.split('/')[1].split(' - ')[1].split(' ')[0])
    const kind = file.name.split('/')[1].split(' - ')[3] as StemKind

    stemMetadata.push({
      name,
      bpm,
      kind,
      fileName: file.name,
      zipFile: file
    })
  }

  // Sort stems within ZIP file for consistent ordering
  // Sort by: 1) BPM, 2) Kind, 3) Name
  stemMetadata.sort((a, b) => {
    if (a.bpm !== b.bpm) return a.bpm - b.bpm
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return a.name.localeCompare(b.name)
  })

  return stemMetadata
}

async function decodeAudioForStem(audio: AudioContext, zipFile: JSZip.JSZipObject): Promise<AudioBuffer> {
  const arrayBuffer = await zipFile.async('arraybuffer')
  return await audio.decodeAudioData(arrayBuffer)
}

async function readZipFile(audio: AudioContext, dirHandle: FileSystemDirectoryHandle, fileName: string) {
  const fileHandle = await dirHandle.getFileHandle(fileName)
  const zipFile = await fileHandle.getFile()
  const arrayBuffer = await zipFile.arrayBuffer()

  const zip = new JSZip()
  const zipContent = await zip.loadAsync(arrayBuffer)

  // NOTE: The following code is brittle. We expect
  // certain patterns to be followed by the stems zip and its contents,
  // so any weird deviation will most likely break something here.
  let stems: Stem[] = []
  for (const file of Object.values(zipContent.files)) {
    if (file.dir) continue
    const name = file.name.split('/')[1].split(' - ').slice(2).join(' - ').replace('.wav', '')
    const bpm = Number(file.name.split('/')[1].split(' - ')[1].split(' ')[0])
    const kind = file.name.split('/')[1].split(' - ')[3] as StemKind

    const arrayBuffer = await file.async('arraybuffer')
    const buffer = await audio.decodeAudioData(arrayBuffer)

    const stem: Stem = {
      name,
      bpm,
      kind,
      buffer
    }

    stems.push(stem)
  }

  // Sort stems for consistent ordering
  // Sort by: 1) BPM, 2) Kind, 3) Name
  stems.sort((a, b) => {
    if (a.bpm !== b.bpm) return a.bpm - b.bpm
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return a.name.localeCompare(b.name)
  })

  return stems
}

export {
  selectDirectory,
  loadSavedDirectory,
  findZipFiles,
  readZipFileMetadata,
  decodeAudioForStem,
  readZipFile,
  directoryHandle,
  onDirectoryLoaded,
  setOnDirectoryLoaded
}

function setOnDirectoryLoaded(callback: ((handle: FileSystemDirectoryHandle) => void | Promise<void>) | null): void {
  onDirectoryLoaded = callback
}
