using System.Windows;
using System.Windows.Input;
using System.Windows.Media;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// Yes/no confirmation drawn in the app's own style. Replaces MessageBox everywhere in the client.
/// </summary>
public partial class ConfirmDialog : Window
{
    private ConfirmDialog()
    {
        InitializeComponent();
        OkButton.Click += (_, _) => DialogResult = true;
        CancelButton.Click += (_, _) => DialogResult = false;

        // No title bar to drag by: the whole card moves the window instead.
        MouseLeftButtonDown += (_, e) =>
        {
            if (e.ButtonState == MouseButtonState.Pressed) DragMove();
        };
    }

    /// <summary>
    /// Asks and waits. Returns true only for the confirm button; Esc, Cancel and closing are all false.
    /// </summary>
    /// <param name="owner">Window to centre on and block; null uses the app's main window.</param>
    /// <param name="danger">Red confirm button, for actions that remove something.</param>
    public static bool Ask(Window? owner, string title, string message, string? confirmText = null, bool danger = false)
    {
        var dialog = new ConfirmDialog
        {
            Owner = owner ?? Application.Current?.MainWindow,
        };
        dialog.TitleText.Text = title;
        dialog.MessageText.Text = message;
        if (!string.IsNullOrEmpty(confirmText))
        {
            dialog.OkButton.Content = confirmText;
        }

        if (danger)
        {
            var crit = (Brush)dialog.FindResource("StatusCritBrush");
            dialog.OkButton.Background = crit;
            dialog.OkButton.Foreground = (Brush)dialog.FindResource("StatusCritInkBrush");
            dialog.Accent.Background = crit;
        }

        if (dialog.Owner is null || !dialog.Owner.IsLoaded)
        {
            dialog.Owner = null;
            dialog.WindowStartupLocation = WindowStartupLocation.CenterScreen;
        }

        return dialog.ShowDialog() == true;
    }
}
