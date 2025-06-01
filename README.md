# Technolooper Grid

A responsive grid application built with Vite and TypeScript that creates toggleable squares with bright colors and smooth animations.

## Features

- **Responsive Grid**: Automatically arranges any number of items perfectly across the screen
- **Mobile Support**: Full touch event support for mobile devices
- **Visual Feedback**: Play icon SVG for active cells, dimmed colors for inactive cells
- **Consistent Colors**: Custom seeded RNG ensures the same color palette every time
- **Dark Theme**: Modern dark theme with bright accent colors
- **URL Persistence**: Active cells are saved in URL and restored on refresh
- **Keyboard Shortcuts**:
  - Press `r` to reset all cells
  - Press `a` to activate all cells
- **URL Parameters**: Set grid size with `?size=X` (e.g., `?size=100` for 100 cells)

## Usage

### Development
```bash
pnpm dev
```

### Build
```bash
pnpm build
```

### Preview
```bash
pnpm preview
```

## Grid Customization

You can customize the grid size by adding a URL parameter:
- `http://localhost:5173/?size=16` - Creates a 16-cell grid
- `http://localhost:5173/?size=64` - Creates a 64-cell grid (default)
- `http://localhost:5173/?size=144` - Creates a 144-cell grid

### URL Persistence

Active cells are automatically saved in the URL and restored when the page refreshes:
- `http://localhost:5173/?size=16&active=0,5,10,15` - 16-cell grid with cells 0, 5, 10, and 15 active
- Share URLs to preserve exact grid patterns
- Bookmark specific configurations for later use

## JavaScript API

The application exposes a `looper` object on the window for programmatic control:

```javascript
// Set the number of grid cells (automatically arranges layout)
looper.setGridCells(50);

// Toggle a specific cell (0-based index)
looper.toggleCell(5);

// Reset all cells to inactive
looper.resetGrid();

// Activate all cells
looper.activateAll();

// Set callback to receive updates when cells change
looper.onCellsUpdated((activeCells) => {
  console.log('Active cells:', activeCells);
  // activeCells is an array of indices like [0, 5, 12, 23]
});

// Get current active cells
const activeCells = looper.getActiveCells();

// Get current grid size
const currentSize = looper.getGridSize();

// Remove callback
looper.onCellsUpdated(null);
```

### Callback Usage Example

```javascript
// Track active cells for music sequencing
looper.onCellsUpdated((activeCells) => {
  // activeCells contains indices of all active cells
  // Example: [0, 7, 14, 21] means cells at those positions are active

  if (activeCells.length > 0) {
    console.log(`${activeCells.length} cells are active`);
    activeCells.forEach(index => {
      console.log(`Cell ${index} is active`);
    });
  } else {
    console.log('No cells are active');
  }
});

// Example: Create a simple pattern
looper.setGridCells(16);  // 4x4 grid
looper.toggleCell(0);     // Top-left
looper.toggleCell(5);     // Middle
looper.toggleCell(10);    // Another spot
looper.toggleCell(15);    // Bottom-right

console.log('Current pattern:', looper.getActiveCells());
```

## Technical Details

- Built with **Vite** for fast development and building
- **TypeScript** for type safety
- Uses CSS Grid for perfect responsive layout
- Custom seeded random number generator for consistent colors
- Touch event handling with proper preventDefault for mobile
- Automatic window resize handling
- Modern CSS with `dvw` and `dvh` units for full viewport coverage
- Smart grid arrangement algorithm that optimizes layout based on screen dimensions

## Browser Support

Works on all modern browsers with support for:
- CSS Grid
- Touch Events
- ES6+ JavaScript features
- CSS custom properties
