using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// ตัวแก้ผัง wall แบบรวมช่อง: เลือกขนาดกริด ลากเลือกสี่เหลี่ยมแล้วกดรวมหรือแยกช่อง
///
/// เป็นหน้าต่างแยกที่ไม่มีวิดีโอ จึงวาด WPF ได้อิสระโดยไม่ชน HWND ของ wall
/// ผังที่บันทึกเก็บใน AppSettings ของเครื่องนี้ เหมือน saved views
/// </summary>
public sealed class WallLayoutEditorWindow : Window
{
    private readonly AppSettings _settings;
    private readonly ListBox _list = new() { MinWidth = 180, Margin = new Thickness(0, 6, 0, 8) };
    private readonly TextBox _name = new() { Margin = new Thickness(0, 6, 0, 12), Padding = new Thickness(6, 4, 6, 4) };
    private readonly ComboBox _rows = new() { Width = 64, Margin = new Thickness(6, 0, 16, 0) };
    private readonly ComboBox _columns = new() { Width = 64, Margin = new Thickness(6, 0, 0, 0) };
    private readonly Grid _canvas = new() { Background = Brushes.Transparent, ClipToBounds = true };
    private readonly Border _canvasFrame = new() { BorderThickness = new Thickness(1), Margin = new Thickness(0, 12, 0, 8) };
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 4, 0, 8) };
    private readonly List<int[]> _merges = new();
    private string? _editingId;
    private int _rowCount = 3;
    private int _columnCount = 3;
    private (int Row, int Column)? _dragStart;
    private (int Row, int Column, int RowSpan, int ColumnSpan)? _selection;
    private bool _loading;

    /// <summary>ผังที่ผู้ใช้กด "ใช้ผังนี้" หลังบันทึก; null = ปิดโดยไม่เปลี่ยนผังของ wall</summary>
    public WallLayoutDefinition? Result { get; private set; }

    public WallLayoutEditorWindow(AppSettings settings, WallLayoutDefinition current)
    {
        _settings = settings;
        Title = Strings.T("layout.editorTitle");
        Width = 860; Height = 600; MinWidth = 640; MinHeight = 460;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        SetResourceReference(BackgroundProperty, "SurfaceBrush");
        SetResourceReference(ForegroundProperty, "ForegroundBrush");
        SetResourceReference(FontFamilyProperty, "UiFont");
        _canvasFrame.SetResourceReference(Border.BorderBrushProperty, "BorderBrush");
        _canvasFrame.SetResourceReference(Border.BackgroundProperty, "VideoGroundBrush");
        _status.SetResourceReference(TextBlock.ForegroundProperty, "MutedForegroundBrush");
        _list.SetResourceReference(BackgroundProperty, "BackgroundBrush");
        _list.SetResourceReference(ForegroundProperty, "ForegroundBrush");

        var root = new DockPanel { Margin = new Thickness(16) };

        // ซ้าย: ผังที่บันทึกไว้
        var left = new DockPanel { Margin = new Thickness(0, 0, 16, 0) };
        var savedLabel = Label(Strings.T("layout.saved"));
        DockPanel.SetDock(savedLabel, Dock.Top); left.Children.Add(savedLabel);
        var newButton = Ghost(Strings.T("layout.new"));
        var deleteButton = Ghost(Strings.T("layout.delete"));
        var leftButtons = new StackPanel { Orientation = Orientation.Horizontal };
        leftButtons.Children.Add(newButton); leftButtons.Children.Add(deleteButton);
        DockPanel.SetDock(leftButtons, Dock.Bottom); left.Children.Add(leftButtons);
        left.Children.Add(_list);
        DockPanel.SetDock(left, Dock.Left); root.Children.Add(left);

        // ล่าง: ปุ่มบันทึก/ใช้
        var saveButton = Ghost(Strings.T("layout.save"));
        var useButton = new Button { Content = Strings.T("layout.saveAndUse"), Padding = new Thickness(12, 6, 12, 6), Margin = new Thickness(0, 0, 8, 0) };
        useButton.SetResourceReference(StyleProperty, "PrimaryButton");
        var closeButton = Ghost(Strings.T("layout.close"));
        var bottom = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        bottom.Children.Add(saveButton); bottom.Children.Add(useButton); bottom.Children.Add(closeButton);
        DockPanel.SetDock(bottom, Dock.Bottom); root.Children.Add(bottom);

        // ขวา: ชื่อ ขนาดกริด และพื้นที่ลากเลือก
        var right = new DockPanel();
        var top = new StackPanel();
        top.Children.Add(Label(Strings.T("layout.name")));
        top.Children.Add(_name);
        var size = new StackPanel { Orientation = Orientation.Horizontal };
        size.Children.Add(Label(Strings.T("layout.rows"))); size.Children.Add(_rows);
        size.Children.Add(Label(Strings.T("layout.columns"))); size.Children.Add(_columns);
        top.Children.Add(size);
        var tools = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0) };
        var mergeButton = Ghost(Strings.T("layout.merge"));
        var splitButton = Ghost(Strings.T("layout.split"));
        var resetButton = Ghost(Strings.T("layout.reset"));
        tools.Children.Add(mergeButton); tools.Children.Add(splitButton); tools.Children.Add(resetButton);
        top.Children.Add(tools);
        DockPanel.SetDock(top, Dock.Top); right.Children.Add(top);
        DockPanel.SetDock(_status, Dock.Bottom); right.Children.Add(_status);
        _canvasFrame.Child = _canvas;
        right.Children.Add(_canvasFrame);
        root.Children.Add(right);
        Content = root;

        for (var i = WallLayouts.MinSide; i <= WallLayouts.MaxSide; i++) { _rows.Items.Add(i); _columns.Items.Add(i); }
        _rows.SelectionChanged += (_, _) => Resize();
        _columns.SelectionChanged += (_, _) => Resize();
        _list.SelectionChanged += (_, _) => { if (!_loading && _list.SelectedItem is WallLayoutDefinition l) Load(l, l.Id, l.Name); };
        newButton.Click += (_, _) => { _list.SelectedItem = null; Load(WallLayouts.Resolve("1+5", null, 6), null, string.Empty); };
        deleteButton.Click += (_, _) => DeleteSelected();
        mergeButton.Click += (_, _) => MergeSelection();
        splitButton.Click += (_, _) => SplitSelection();
        resetButton.Click += (_, _) => { _merges.Clear(); _selection = null; Render(); };
        saveButton.Click += (_, _) => Save();
        useButton.Click += (_, _) => { var saved = Save(); if (saved is null) return; Result = saved; DialogResult = true; };
        closeButton.Click += (_, _) => Close();
        _canvas.MouseLeftButtonDown += OnCanvasDown;
        _canvas.MouseMove += OnCanvasMove;
        _canvas.MouseLeftButtonUp += (_, _) => { _dragStart = null; _canvas.ReleaseMouseCapture(); };
        _canvas.SizeChanged += (_, _) => FitCanvas();
        _canvasFrame.SizeChanged += (_, _) => FitCanvas();

        RefreshList();
        // เปิดผังที่ใช้อยู่: ผังของผู้ใช้แก้ต่อได้เลย ผังสำเร็จรูปเป็นแม่แบบของผังใหม่
        if (!current.IsBuiltIn && _settings.WallLayouts.FirstOrDefault(l => l.Id == current.Id) is { } mine)
        {
            _list.SelectedItem = mine;
        }
        else
        {
            Load(current, null, string.Empty);
        }
    }

    private static TextBlock Label(string text)
    {
        var label = new TextBlock { Text = text, VerticalAlignment = VerticalAlignment.Center };
        label.SetResourceReference(StyleProperty, "LabelText");
        return label;
    }

    private static Button Ghost(string text)
    {
        var button = new Button { Content = text, Padding = new Thickness(10, 6, 10, 6), Margin = new Thickness(0, 0, 8, 0) };
        button.SetResourceReference(StyleProperty, "GhostButton");
        return button;
    }

    private void RefreshList()
    {
        _loading = true;
        var selectedId = (_list.SelectedItem as WallLayoutDefinition)?.Id ?? _editingId;
        _list.Items.Clear();
        foreach (var layout in _settings.WallLayouts) _list.Items.Add(layout);
        _list.SelectedItem = _settings.WallLayouts.FirstOrDefault(l => l.Id == selectedId);
        _loading = false;
    }

    /// <summary>โหลดผังเข้าตัวแก้; id null = กำลังสร้างผังใหม่จากแม่แบบ</summary>
    private void Load(WallLayoutDefinition layout, string? id, string name)
    {
        _editingId = id;
        _name.Text = name;
        _merges.Clear();
        _merges.AddRange(layout.Cells.Where(c => c[2] > 1 || c[3] > 1).Select(c => (int[])c.Clone()));
        _rowCount = layout.Rows;
        _columnCount = layout.Columns;
        _selection = null;
        _loading = true;
        _rows.SelectedItem = _rowCount;
        _columns.SelectedItem = _columnCount;
        _loading = false;
        Render();
    }

    /// <summary>เปลี่ยนขนาดกริด: ตัดช่องรวมที่หลุดขอบกริดใหม่ทิ้ง</summary>
    private void Resize()
    {
        if (_loading || _rows.SelectedItem is not int rows || _columns.SelectedItem is not int columns) return;
        _rowCount = rows;
        _columnCount = columns;
        _merges.RemoveAll(m => m[0] + m[2] > rows || m[1] + m[3] > columns);
        _selection = null;
        Render();
    }

    private WallLayoutDefinition? Current(string id, string name) =>
        WallLayouts.Build(id, name, _rowCount, _columnCount, _merges, builtIn: false);

    /// <summary>วาดผังลงพื้นที่แก้: ช่องละกรอบพร้อมเลขลำดับ และกรอบสีเหลืองของส่วนที่ลากเลือก</summary>
    private void Render()
    {
        _canvas.Children.Clear();
        _canvas.RowDefinitions.Clear();
        _canvas.ColumnDefinitions.Clear();
        for (var r = 0; r < _rowCount; r++) _canvas.RowDefinitions.Add(new RowDefinition());
        for (var c = 0; c < _columnCount; c++) _canvas.ColumnDefinitions.Add(new ColumnDefinition());

        var layout = Current("preview", _name.Text);
        if (layout is not null)
        {
            var rects = layout.Rects;
            for (var i = 0; i < rects.Count; i++)
            {
                var rect = rects[i];
                var number = new TextBlock { Text = (i + 1).ToString(), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, FontSize = 16 };
                number.SetResourceReference(TextBlock.ForegroundProperty, "MutedForegroundBrush");
                var cell = new Border { BorderThickness = new Thickness(1), Margin = new Thickness(2), Child = number, IsHitTestVisible = false };
                cell.SetResourceReference(Border.BorderBrushProperty, "BorderBrush");
                cell.SetResourceReference(Border.BackgroundProperty, rect.RowSpan > 1 || rect.ColumnSpan > 1 ? "DataSoftBrush" : "CardBrush");
                Place(cell, rect.Row, rect.Column, rect.RowSpan, rect.ColumnSpan);
                _canvas.Children.Add(cell);
            }
        }

        if (_selection is { } s)
        {
            var mark = new Border { BorderThickness = new Thickness(3), IsHitTestVisible = false };
            mark.SetResourceReference(Border.BorderBrushProperty, "BrandYellowBrush");
            Place(mark, s.Row, s.Column, s.RowSpan, s.ColumnSpan);
            _canvas.Children.Add(mark);
        }

        var count = layout?.CellCount ?? CountCells();
        _status.Text = count > WallLayouts.MaxCells
            ? Strings.T("layout.tooMany", count, WallLayouts.MaxCells)
            : Strings.T("layout.summary", count, WallLayouts.MaxCells);
        FitCanvas();
    }

    private int CountCells() =>
        _rowCount * _columnCount - _merges.Sum(m => m[2] * m[3]) + _merges.Count;

    private static void Place(UIElement element, int row, int column, int rowSpan, int columnSpan)
    {
        Grid.SetRow(element, row); Grid.SetColumn(element, column);
        Grid.SetRowSpan(element, rowSpan); Grid.SetColumnSpan(element, columnSpan);
    }

    /// <summary>ให้พื้นที่แก้มีสัดส่วนเดียวกับ wall จริง (แต่ละช่อง 16:9)</summary>
    private void FitCanvas()
    {
        var width = Math.Max(0, _canvasFrame.ActualWidth - 2);
        var height = Math.Max(0, _canvasFrame.ActualHeight - 2);
        if (width <= 0 || height <= 0) return;
        var ratio = (16d / 9d) * _columnCount / _rowCount;
        _canvas.Width = Math.Min(width, height * ratio);
        _canvas.Height = Math.Min(height, width / ratio);
    }

    private (int Row, int Column) HitCell(Point p)
    {
        var row = (int)(p.Y / Math.Max(1, _canvas.ActualHeight) * _rowCount);
        var column = (int)(p.X / Math.Max(1, _canvas.ActualWidth) * _columnCount);
        return (Math.Clamp(row, 0, _rowCount - 1), Math.Clamp(column, 0, _columnCount - 1));
    }

    private void OnCanvasDown(object sender, MouseButtonEventArgs e)
    {
        _dragStart = HitCell(e.GetPosition(_canvas));
        _canvas.CaptureMouse();
        Select(_dragStart.Value, _dragStart.Value);
    }

    private void OnCanvasMove(object sender, MouseEventArgs e)
    {
        if (_dragStart is null || e.LeftButton != MouseButtonState.Pressed) return;
        Select(_dragStart.Value, HitCell(e.GetPosition(_canvas)));
    }

    private void Select((int Row, int Column) a, (int Row, int Column) b)
    {
        var row = Math.Min(a.Row, b.Row);
        var column = Math.Min(a.Column, b.Column);
        var next = (row, column, Math.Abs(a.Row - b.Row) + 1, Math.Abs(a.Column - b.Column) + 1);
        if (_selection == next) return;
        _selection = next;
        Render();
    }

    private static bool Overlaps(int[] m, (int Row, int Column, int RowSpan, int ColumnSpan) s) =>
        m[0] < s.Row + s.RowSpan && s.Row < m[0] + m[2] && m[1] < s.Column + s.ColumnSpan && s.Column < m[1] + m[3];

    private static bool Inside(int[] m, (int Row, int Column, int RowSpan, int ColumnSpan) s) =>
        m[0] >= s.Row && m[1] >= s.Column && m[0] + m[2] <= s.Row + s.RowSpan && m[1] + m[3] <= s.Column + s.ColumnSpan;

    /// <summary>รวมส่วนที่เลือกเป็นช่องเดียว; ช่องรวมเดิมที่อยู่ข้างในถูกแทนที่ ส่วนที่ถูกตัดครึ่งไม่ยอมให้รวม</summary>
    private void MergeSelection()
    {
        if (_selection is not { } s) { _status.Text = Strings.T("layout.selectFirst"); return; }
        if (s.RowSpan * s.ColumnSpan < 2) { _status.Text = Strings.T("layout.selectMore"); return; }
        if (_merges.Any(m => Overlaps(m, s) && !Inside(m, s))) { _status.Text = Strings.T("layout.crossesMerged"); return; }
        _merges.RemoveAll(m => Inside(m, s));
        _merges.Add(new[] { s.Row, s.Column, s.RowSpan, s.ColumnSpan });
        _selection = null;
        Render();
    }

    /// <summary>แยกช่องรวมทุกช่องที่แตะส่วนที่เลือกกลับเป็นช่องเดี่ยว</summary>
    private void SplitSelection()
    {
        if (_selection is not { } s) { _status.Text = Strings.T("layout.selectFirst"); return; }
        _merges.RemoveAll(m => Overlaps(m, s));
        _selection = null;
        Render();
    }

    /// <summary>บันทึกผัง (ใหม่หรือทับของเดิม); คืน null เมื่อไม่มีชื่อหรือผังไม่ผ่านการตรวจ</summary>
    private WallLayoutDefinition? Save()
    {
        var name = _name.Text.Trim();
        if (name.Length == 0) { _status.Text = Strings.T("layout.needsName"); return null; }
        var sameName = _settings.WallLayouts.FirstOrDefault(l => l.Id != _editingId && string.Equals(l.Name, name, StringComparison.OrdinalIgnoreCase));
        if (sameName is not null) { _status.Text = Strings.T("layout.nameTaken", name); return null; }

        var layout = Current(_editingId ?? "c-" + Guid.NewGuid().ToString("n")[..12], name);
        if (layout is null) { _status.Text = Strings.T("layout.tooMany", CountCells(), WallLayouts.MaxCells); return null; }

        var index = _settings.WallLayouts.FindIndex(l => l.Id == layout.Id);
        if (index >= 0) _settings.WallLayouts[index] = layout; else _settings.WallLayouts.Add(layout);
        _settings.Save();
        _editingId = layout.Id;
        RefreshList();
        _list.SelectedItem = layout;
        _status.Text = Strings.T("layout.savedNote", name);
        return layout;
    }

    private void DeleteSelected()
    {
        if (_list.SelectedItem is not WallLayoutDefinition layout) return;
        if (!ConfirmDialog.Ask(this, Strings.T("layout.delete"), Strings.T("layout.deleteConfirm", layout.Name), Strings.T("layout.delete"), danger: true)) return;
        _settings.WallLayouts.RemoveAll(l => l.Id == layout.Id);
        _settings.Save();
        if (_editingId == layout.Id) _editingId = null;
        RefreshList();
        _status.Text = Strings.T("layout.deleted", layout.Name);
    }
}
