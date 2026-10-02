using System;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SurveillanceGateway.Client.Models;

/// <summary>
/// Reads a number that may arrive as a JSON string.
///
/// The gateway serialises rows straight out of SQLite, which has no fixed column types: the same
/// column holds 3 for one row and "3" for another depending on how it was written. `role_id`
/// comes back quoted today, and any other numeric column is free to do the same tomorrow. A
/// strict binding turns that into a login failure with a JSON path in the message, which tells
/// an operator nothing.
/// </summary>
public sealed class FlexibleIntConverter : JsonConverter<int?>
{
    public override int? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.Null:
                return null;
            case JsonTokenType.Number:
                return reader.TryGetInt32(out var number) ? number : null;
            case JsonTokenType.True:
                return 1;
            case JsonTokenType.False:
                return 0;
            case JsonTokenType.String:
                var text = reader.GetString();
                return int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
                    ? parsed
                    : null;
            default:
                return null;
        }
    }

    public override void Write(Utf8JsonWriter writer, int? value, JsonSerializerOptions options)
    {
        if (value is null)
        {
            writer.WriteNullValue();
        }
        else
        {
            writer.WriteNumberValue(value.Value);
        }
    }
}

/// <summary>Same tolerance for the floating-point columns - lat and lng.</summary>
public sealed class FlexibleDoubleConverter : JsonConverter<double?>
{
    public override double? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.Null:
                return null;
            case JsonTokenType.Number:
                return reader.TryGetDouble(out var number) ? number : null;
            case JsonTokenType.String:
                var text = reader.GetString();
                return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)
                    ? parsed
                    : null;
            default:
                return null;
        }
    }

    public override void Write(Utf8JsonWriter writer, double? value, JsonSerializerOptions options)
    {
        if (value is null)
        {
            writer.WriteNullValue();
        }
        else
        {
            writer.WriteNumberValue(value.Value);
        }
    }
}
