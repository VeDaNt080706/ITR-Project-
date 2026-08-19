package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"
	"golang.org/x/sys/windows"
)

// ANSI color codes for enhanced terminal visibility
const (
	colorReset   = "\033[0m"
	colorRed     = "\033[31;1m"
	colorGreen   = "\033[32;1m"
	colorYellow  = "\033[33;1m"
	colorBlue    = "\033[34;1m"
	colorMagenta = "\033[35;1m"
	colorCyan    = "\033[36;1m"
	colorGray    = "\033[90m"
	colorBold    = "\033[1m"
)

// FileMetadata tracks the known state of a file
type FileMetadata struct {
	Path        string
	Size        int64
	ModTime     time.Time
	Hash        string
	LastUpdated time.Time
	Logged      bool // true once CREATE, COPY, or MOVE has been announced
}

// PendingEvent tracks recent filesystem operations for correlation
type PendingEvent struct {
	Op       fsnotify.Op
	Path     string
	Size     int64
	Hash     string
	Time     time.Time
	Detected bool
}

// FileMonitor manages directory watching and event correlation
type FileMonitor struct {
	watcher         *fsnotify.Watcher
	mu              sync.RWMutex
	fileCache       map[string]*FileMetadata // path -> metadata
	recentRemovals  map[string]*PendingEvent // path -> PendingEvent
	recentRenames   map[string]*PendingEvent // oldPath -> PendingEvent
	recentCreates   map[string]*PendingEvent // newPath -> PendingEvent
	newlyCreated    map[string]time.Time     // path -> time created
	activeDebounces map[string]*time.Timer   // path -> debounce timer
	watchedFolders  []string
	systemDrive     string
}

func initConsole() {
	_ = windows.SetConsoleCP(65001)
	_ = windows.SetConsoleOutputCP(65001)

	stdout := windows.Handle(os.Stdout.Fd())
	var mode uint32
	if err := windows.GetConsoleMode(stdout, &mode); err == nil {
		mode |= windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING
		_ = windows.SetConsoleMode(stdout, mode)
	}
}

func logMessage(format string, a ...interface{}) {
	fmt.Printf(format, a...)
	_ = os.Stdout.Sync()
}

func formatBytes(bytes int64) string {
	if bytes <= 0 {
		return "0 B"
	}
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	units := []string{"KB", "MB", "GB", "TB"}
	if exp >= len(units) {
		exp = len(units) - 1
	}
	return fmt.Sprintf("%.1f %s", float64(bytes)/float64(div), units[exp])
}

func getTimestamp() string {
	return time.Now().Format("2006-01-02 15:04:05")
}

// isNoiseFile filters out temporary system, lock, and log files
func isNoiseFile(path string) bool {
	name := strings.ToLower(filepath.Base(path))
	return strings.HasPrefix(name, "~$") ||
		strings.HasPrefix(name, ".~") ||
		strings.HasSuffix(name, ".tmp") ||
		strings.HasSuffix(name, ".log") ||
		strings.HasSuffix(name, ".crdownload") ||
		strings.HasSuffix(name, ".part") ||
		name == "desktop.ini" ||
		name == "thumbs.db" ||
		name == ".ds_store"
}

// shouldSkipDir skips system/noise directories during recursive watching
func shouldSkipDir(name string) bool {
	lower := strings.ToLower(name)
	switch lower {
	case "node_modules", "vendor", "$recycle.bin", "system volume information",
		"recovery", "windows", "program files", "program files (x86)",
		"programdata", "perflogs", "msocache", "config.msi",
		"boot", "mingw", "go":
		return true
	}
	if strings.HasPrefix(name, ".") && len(name) > 1 {
		return true
	}
	return false
}

// isDriveRoot checks if path is a drive root like "E:\" or "D:\"
func isDriveRoot(path string) bool {
	clean := strings.TrimRight(filepath.Clean(path), `/\`)
	return len(clean) == 2 && clean[1] == ':'
}

// computeFastHash computes a SHA-256 hash of the first 1MB of the file
func computeFastHash(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return "", 0, err
	}

	if fi.Size() == 0 {
		return "empty", 0, nil
	}

	h := sha256.New()
	_, err = io.CopyN(h, f, 1024*1024)
	if err != nil && err != io.EOF {
		return "", fi.Size(), err
	}

	return hex.EncodeToString(h.Sum(nil)), fi.Size(), nil
}

// isExternalDevice checks if the path resides on an external or non-system drive
func (m *FileMonitor) isExternalDevice(path string) bool {
	vol := filepath.VolumeName(path)
	if vol == "" {
		return false
	}
	rootPath := strings.TrimRight(vol, `\/`) + `\`
	rootPtr, err := syscall.UTF16PtrFromString(rootPath)
	if err != nil {
		return false
	}

	driveType := windows.GetDriveType(rootPtr)
	if driveType == windows.DRIVE_REMOVABLE || driveType == windows.DRIVE_REMOTE {
		return true
	}
	if m.systemDrive != "" && !strings.EqualFold(vol, m.systemDrive) {
		return true
	}
	return false
}

func getAvailableNonSystemDrives(systemDrive string) []string {
	bitmask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil
	}
	var drives []string
	for i := 0; i < 26; i++ {
		if (bitmask & (1 << uint(i))) != 0 {
			driveLetter := fmt.Sprintf("%c:", 'A'+i)
			if !strings.EqualFold(driveLetter, systemDrive) {
				drives = append(drives, driveLetter+`\`)
			}
		}
	}
	return drives
}

func NewFileMonitor(folders []string) (*FileMonitor, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	systemDrive := os.Getenv("SystemDrive")
	if systemDrive == "" {
		systemDrive = "C:"
	}

	return &FileMonitor{
		watcher:         watcher,
		fileCache:       make(map[string]*FileMetadata),
		recentRemovals:  make(map[string]*PendingEvent),
		recentRenames:   make(map[string]*PendingEvent),
		recentCreates:   make(map[string]*PendingEvent),
		newlyCreated:    make(map[string]time.Time),
		activeDebounces: make(map[string]*time.Timer),
		watchedFolders:  folders,
		systemDrive:     systemDrive,
	}, nil
}

// walkAndWatch recursively walks a directory tree, watches directories, and caches initial files
func (m *FileMonitor) walkAndWatch(root string, maxDepth int) {
	rootDepth := strings.Count(filepath.Clean(root), string(filepath.Separator))

	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil {
			return nil
		}

		if info.IsDir() {
			if maxDepth > 0 {
				depth := strings.Count(filepath.Clean(path), string(filepath.Separator)) - rootDepth
				if depth > maxDepth {
					return filepath.SkipDir
				}
			}
			if shouldSkipDir(info.Name()) && path != root {
				return filepath.SkipDir
			}
			_ = m.watcher.Add(path)
			return nil
		}

		if !isNoiseFile(path) {
			m.mu.Lock()
			m.fileCache[path] = &FileMetadata{
				Path:        path,
				Size:        info.Size(),
				ModTime:     info.ModTime(),
				LastUpdated: time.Now(),
				Logged:      true, // Initial existing files are marked as logged
			}
			m.mu.Unlock()
		}
		return nil
	})
}

// SetupWatching sets up recursive watching for user profile folders and non-system drives
func (m *FileMonitor) SetupWatching() {
	for _, folder := range m.watchedFolders {
		if _, err := os.Stat(folder); os.IsNotExist(err) {
			continue
		}
		if isDriveRoot(folder) {
			m.walkAndWatch(folder, 2)
		} else {
			m.walkAndWatch(folder, 0)
		}
	}
}

// StartEventLoop processes events from fsnotify
func (m *FileMonitor) StartEventLoop() {
	// Cleanup routine for expired pending events
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			m.mu.Lock()
			now := time.Now()
			for k, v := range m.recentRemovals {
				if now.Sub(v.Time) > 5*time.Second {
					delete(m.recentRemovals, k)
				}
			}
			for k, v := range m.recentRenames {
				if now.Sub(v.Time) > 5*time.Second {
					delete(m.recentRenames, k)
				}
			}
			for k, v := range m.recentCreates {
				if now.Sub(v.Time) > 5*time.Second {
					delete(m.recentCreates, k)
				}
			}
			for k, t := range m.newlyCreated {
				if now.Sub(t) > 10*time.Second {
					delete(m.newlyCreated, k)
				}
			}
			m.mu.Unlock()
		}
	}()

	for {
		select {
		case event, ok := <-m.watcher.Events:
			if !ok {
				return
			}
			m.handleEvent(event)
		case err, ok := <-m.watcher.Errors:
			if !ok {
				return
			}
			if err != nil {
				logMessage("%s[Error]%s %v\n", colorRed, colorReset, err)
			}
		}
	}
}

func (m *FileMonitor) handleEvent(event fsnotify.Event) {
	path := event.Name
	if isNoiseFile(path) {
		return
	}

	// Handle new directory creation: start watching it immediately
	if event.Has(fsnotify.Create) {
		if fi, err := os.Stat(path); err == nil && fi.IsDir() {
			if !shouldSkipDir(fi.Name()) {
				_ = m.watcher.Add(path)
			}
			return
		}
		// Record that this file was created brand new
		m.mu.Lock()
		m.newlyCreated[path] = time.Now()
		m.mu.Unlock()
	}

	switch {
	case event.Has(fsnotify.Rename):
		m.handleRenameOp(path)
	case event.Has(fsnotify.Remove):
		m.handleRemoveOp(path)
	case event.Has(fsnotify.Create) || event.Has(fsnotify.Write):
		m.handleWriteOrCreateOp(path)
	}
}

func (m *FileMonitor) handleRenameOp(oldPath string) {
	m.mu.Lock()
	meta, exists := m.fileCache[oldPath]
	var size int64
	var hash string
	if exists {
		size = meta.Size
		hash = meta.Hash
		delete(m.fileCache, oldPath)
	}
	m.recentRenames[oldPath] = &PendingEvent{
		Op:   fsnotify.Rename,
		Path: oldPath,
		Size: size,
		Hash: hash,
		Time: time.Now(),
	}
	m.mu.Unlock()
}

func (m *FileMonitor) handleRemoveOp(removedPath string) {
	m.mu.Lock()
	meta, exists := m.fileCache[removedPath]
	var size int64
	var hash string
	if exists {
		size = meta.Size
		hash = meta.Hash
		delete(m.fileCache, removedPath)
	}
	removalEv := &PendingEvent{
		Op:   fsnotify.Remove,
		Path: removedPath,
		Size: size,
		Hash: hash,
		Time: time.Now(),
	}
	m.recentRemovals[removedPath] = removalEv

	// Immediately check if a recent CREATE on a DIFFERENT path matches this removal (cross-drive move)
	now := time.Now()
	for createPath, createEv := range m.recentCreates {
		if strings.EqualFold(removedPath, createPath) || createEv.Detected {
			continue
		}
		if now.Sub(createEv.Time) > 3*time.Second {
			continue
		}
		isSameName := strings.EqualFold(filepath.Base(removedPath), filepath.Base(createPath))
		isSameHash := hash != "" && createEv.Hash != "" && hash == createEv.Hash
		isSameContent := isSameHash || (size > 0 && size == createEv.Size && isSameName)

		if isSameName || isSameContent {
			removalEv.Detected = true
			createEv.Detected = true
			ts := getTimestamp()
			statusLine := ""
			if m.isExternalDevice(createPath) {
				statusLine = "  Status: ✓ External Device (USB)\n"
			}
			logMessage("\n[%s] %sMOVE DETECTED%s\n  Source: %s\n  Destination: %s\n  File Size: %s\n%s",
				ts, colorYellow, colorReset, removedPath, createPath, formatBytes(createEv.Size), statusLine)
			m.mu.Unlock()
			return
		}
	}
	m.mu.Unlock()

	// Wait briefly to see if this removal is part of a MOVE or RENAME operation
	time.AfterFunc(500*time.Millisecond, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if removalEv.Detected {
			return
		}
		removalEv.Detected = true
		logMessage("\n[%s] %sDELETE DETECTED%s\n  File: %s\n  File Size: %s\n",
			getTimestamp(), colorRed, colorReset, removedPath, formatBytes(size))
	})
}

// handleWriteOrCreateOp debounces rapid write events and processes once writing settles
func (m *FileMonitor) handleWriteOrCreateOp(path string) {
	m.mu.Lock()
	if timer, exists := m.activeDebounces[path]; exists && timer != nil {
		timer.Stop()
	}
	// 400ms debounce gives Windows Explorer time to complete streaming bytes
	m.activeDebounces[path] = time.AfterFunc(400*time.Millisecond, func() {
		m.mu.Lock()
		delete(m.activeDebounces, path)
		m.mu.Unlock()
		m.processSettledFile(path)
	})
	m.mu.Unlock()
}

func (m *FileMonitor) processSettledFile(path string) {
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		return
	}

	size := fi.Size()

	// If the file is still 0 bytes and was just created, wait one more cycle for writes to start
	m.mu.RLock()
	createdTime, wasJustCreated := m.newlyCreated[path]
	m.mu.RUnlock()

	if size == 0 && wasJustCreated && time.Since(createdTime) < 1500*time.Millisecond {
		// Postpone slightly to allow file stream to begin
		m.mu.Lock()
		m.activeDebounces[path] = time.AfterFunc(500*time.Millisecond, func() {
			m.mu.Lock()
			delete(m.activeDebounces, path)
			m.mu.Unlock()
			m.processSettledFile(path)
		})
		m.mu.Unlock()
		return
	}

	hash, _, err := computeFastHash(path)
	if err != nil {
		hash = ""
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	cached, wasCached := m.fileCache[path]
	isNewFile := wasJustCreated || !wasCached || (cached != nil && !cached.Logged)

	// --- Check 1: Match a recent RENAME event ---
	for oldPath, renameEv := range m.recentRenames {
		if strings.EqualFold(oldPath, path) || renameEv.Detected {
			continue
		}
		if now.Sub(renameEv.Time) > 3*time.Second {
			continue
		}

		oldDir := filepath.Dir(oldPath)
		newDir := filepath.Dir(path)
		isSameDir := strings.EqualFold(oldDir, newDir)
		isSameName := strings.EqualFold(filepath.Base(oldPath), filepath.Base(path))
		isSameSize := renameEv.Size > 0 && renameEv.Size == size
		isSameHash := renameEv.Hash != "" && hash != "" && renameEv.Hash == hash

		if !isSameDir && !isSameName && !isSameSize && !isSameHash {
			continue
		}

		renameEv.Detected = true
		delete(m.newlyCreated, path)
		m.fileCache[path] = &FileMetadata{Path: path, Size: size, ModTime: fi.ModTime(), Hash: hash, LastUpdated: now, Logged: true}
		ts := getTimestamp()

		if isSameDir {
			logMessage("\n[%s] %sRENAME DETECTED%s\n  Old Name: %s\n  New Name: %s\n  Path: %s%c\n",
				ts, colorCyan, colorReset, filepath.Base(oldPath), filepath.Base(path), newDir, filepath.Separator)
		} else {
			statusLine := ""
			if m.isExternalDevice(path) {
				statusLine = "  Status: ✓ External Device (USB)\n"
			}
			logMessage("\n[%s] %sMOVE DETECTED%s\n  Source: %s\n  Destination: %s\n  File Size: %s\n%s",
				ts, colorYellow, colorReset, oldPath, path, formatBytes(size), statusLine)
		}
		return
	}

	// --- Check 2: Match a recent REMOVAL (cross-drive/folder move) ---
	for oldPath, remEv := range m.recentRemovals {
		if strings.EqualFold(oldPath, path) || remEv.Detected {
			continue
		}
		if now.Sub(remEv.Time) > 3*time.Second {
			continue
		}
		isSameName := strings.EqualFold(filepath.Base(oldPath), filepath.Base(path))
		isSameHash := hash != "" && remEv.Hash != "" && hash == remEv.Hash
		isSameSize := size > 0 && remEv.Size > 0 && size == remEv.Size

		if isSameName || isSameHash || (isSameSize && isSameName) {
			remEv.Detected = true
			delete(m.newlyCreated, path)
			m.fileCache[path] = &FileMetadata{Path: path, Size: size, ModTime: fi.ModTime(), Hash: hash, LastUpdated: now, Logged: true}
			ts := getTimestamp()

			if strings.EqualFold(filepath.Dir(oldPath), filepath.Dir(path)) && !isSameName {
				logMessage("\n[%s] %sRENAME DETECTED%s\n  Old Name: %s\n  New Name: %s\n  Path: %s%c\n",
					ts, colorCyan, colorReset, filepath.Base(oldPath), filepath.Base(path), filepath.Dir(path), filepath.Separator)
			} else {
				statusLine := ""
				if m.isExternalDevice(path) {
					statusLine = "  Status: ✓ External Device (USB)\n"
				}
				logMessage("\n[%s] %sMOVE DETECTED%s\n  Source: %s\n  Destination: %s\n  File Size: %s\n%s",
					ts, colorYellow, colorReset, oldPath, path, formatBytes(size), statusLine)
			}
			return
		}
	}

	// Register in recentCreates for potential reverse-removal correlation
	m.recentCreates[path] = &PendingEvent{Op: fsnotify.Create, Path: path, Size: size, Hash: hash, Time: now}

	// --- If this is NOT a newly created file, but an established existing file that was edited ---
	if !isNewFile && wasCached && cached != nil && cached.Logged {
		if cached.Size != size || (hash != "" && cached.Hash != "" && cached.Hash != hash) {
			m.fileCache[path] = &FileMetadata{Path: path, Size: size, ModTime: fi.ModTime(), Hash: hash, LastUpdated: now, Logged: true}
			logMessage("\n[%s] %sMODIFY DETECTED%s\n  File: %s\n  File Size: %s\n",
				getTimestamp(), colorMagenta, colorReset, path, formatBytes(size))
		} else {
			m.fileCache[path] = &FileMetadata{Path: path, Size: size, ModTime: fi.ModTime(), Hash: hash, LastUpdated: now, Logged: true}
		}
		return
	}

	// --- Check 4: COPY detection (newly created file matching an existing file) ---
	var copySourcePath string
	destBase := strings.ToLower(filepath.Base(path))
	destExt := strings.ToLower(filepath.Ext(path))
	destStem := strings.TrimSuffix(destBase, destExt)
	destCleanName := strings.ReplaceAll(destStem, "_", " ")

	for srcPath := range m.fileCache {
		if strings.EqualFold(srcPath, path) {
			continue
		}
		srcFi, err := os.Stat(srcPath)
		if err != nil || srcFi.IsDir() {
			continue
		}

		srcSize := srcFi.Size()
		srcBase := strings.ToLower(filepath.Base(srcPath))
		srcExt := strings.ToLower(filepath.Ext(srcPath))
		srcStem := strings.TrimSuffix(srcBase, srcExt)
		srcCleanName := strings.ReplaceAll(srcStem, "_", " ")

		nameAndSizeMatch := (srcBase == destBase || srcCleanName == destCleanName) && srcSize == size && size > 0
		copySuffixMatch := srcSize == size && size > 0 && srcExt == destExt &&
			(strings.HasPrefix(destStem, srcStem+" - copy") ||
				strings.HasPrefix(destStem, srcStem+" (") ||
				strings.HasPrefix(destCleanName, srcCleanName+" - copy") ||
				strings.HasPrefix(destCleanName, srcCleanName+" ("))

		if nameAndSizeMatch || copySuffixMatch {
			copySourcePath = srcPath
			break
		}

		if srcSize == size && size > 0 {
			srcHash, _, _ := computeFastHash(srcPath)
			if srcHash != "" && hash != "" && srcHash == hash && hash != "empty" {
				copySourcePath = srcPath
				break
			}
		}
	}

	delete(m.newlyCreated, path)
	m.fileCache[path] = &FileMetadata{Path: path, Size: size, ModTime: fi.ModTime(), Hash: hash, LastUpdated: now, Logged: true}

	ext := filepath.Ext(path)
	if ext == "" {
		ext = "None"
	}
	ts := getTimestamp()

	if copySourcePath != "" {
		if ev, ok := m.recentCreates[path]; ok {
			ev.Detected = true
		}
		logMessage("\n[%s] %sCOPY DETECTED%s\n  Source: %s\n  Destination: %s\n  File Size: %s\n  File Type: %s\n",
			ts, colorGreen, colorReset, copySourcePath, path, formatBytes(size), ext)
		return
	}

	// --- Check 5: Plain CREATE DETECTED ---
	logMessage("\n[%s] %sCREATE DETECTED%s\n  File: %s\n  File Size: %s\n",
		ts, colorBlue, colorReset, path, formatBytes(size))
}

func main() {
	initConsole()

	homeDir, err := os.UserHomeDir()
	if err != nil {
		logMessage("%s[Error]%s Failed to detect user home directory: %v\n", colorRed, colorReset, err)
		os.Exit(1)
	}

	systemDrive := os.Getenv("SystemDrive")
	if systemDrive == "" {
		systemDrive = "C:"
	}

	// User standard folders on system drive
	potentialFolders := []string{
		filepath.Join(homeDir, "Downloads"),
		filepath.Join(homeDir, "Pictures"),
		filepath.Join(homeDir, "Videos"),
		filepath.Join(homeDir, "Documents"),
		filepath.Join(homeDir, "Desktop"),
		filepath.Join(homeDir, "OneDrive", "Pictures"),
		filepath.Join(homeDir, "OneDrive", "Documents"),
		filepath.Join(homeDir, "OneDrive", "Desktop"),
	}

	// Add all non-system drive roots (D:\, E:\, G:\, H:\ etc.)
	nonSystemDrives := getAvailableNonSystemDrives(systemDrive)
	potentialFolders = append(potentialFolders, nonSystemDrives...)

	folderSet := make(map[string]bool)
	var activeFolders []string
	for _, folder := range potentialFolders {
		if _, err := os.Stat(folder); err == nil {
			clean := filepath.Clean(folder)
			key := strings.ToLower(clean)
			if !folderSet[key] {
				folderSet[key] = true
				activeFolders = append(activeFolders, clean)
			}
		}
	}

	if len(activeFolders) == 0 {
		logMessage("%s[Error]%s No valid directories or drives found to monitor.\n", colorRed, colorReset)
		os.Exit(1)
	}

	monitor, err := NewFileMonitor(activeFolders)
	if err != nil {
		logMessage("%s[Error]%s Failed to initialize watcher: %v\n", colorRed, colorReset, err)
		os.Exit(1)
	}
	defer monitor.watcher.Close()

	// Setup recursive watching & initial file cache for all folders/drives
	monitor.SetupWatching()

	// Print startup banner
	ts := getTimestamp()
	logMessage("[%s] %sFile System Monitor Started%s\n", ts, colorBold, colorReset)
	for _, folder := range activeFolders {
		display := strings.TrimRight(folder, `/\`) + `\`
		logMessage("Watching: %s\n", display)
	}
	logMessage("\n%s[Listening for file system events... Press Ctrl+C to stop]%s\n", colorGray, colorReset)

	// Graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go monitor.StartEventLoop()

	<-sigChan
	logMessage("\n[%s] %sFile System Monitor Stopped.%s\n", getTimestamp(), colorYellow, colorReset)
}
