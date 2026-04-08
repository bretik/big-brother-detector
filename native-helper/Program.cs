using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace BigBrother.NativeHost;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private static async Task<int> Main()
    {
        using var input = Console.OpenStandardInput();
        using var output = Console.OpenStandardOutput();

        while (true)
        {
            var message = await ReadMessageAsync(input);
            if (message is null)
            {
                return 0;
            }

            string responseJson;
            try
            {
                var request = JsonSerializer.Deserialize<NativeRequest>(message, JsonOptions);
                responseJson = request?.Type switch
                {
                    "ping" => JsonSerializer.Serialize(new NativeResponse(true, null, null), JsonOptions),
                    "inspect_tls" => await InspectTlsAsync(request.Hostname),
                    _ => JsonSerializer.Serialize(new NativeResponse(false, null, "Unsupported request type."), JsonOptions)
                };
            }
            catch (Exception ex)
            {
                responseJson = JsonSerializer.Serialize(new NativeResponse(false, null, ex.ToString()), JsonOptions);
            }

            await WriteMessageAsync(output, responseJson);
        }
    }

    private static async Task<string?> ReadMessageAsync(Stream input)
    {
        var lengthBytes = new byte[4];
        var read = await input.ReadAsync(lengthBytes, 0, 4);
        if (read == 0)
        {
            return null;
        }

        while (read < 4)
        {
            var chunk = await input.ReadAsync(lengthBytes, read, 4 - read);
            if (chunk == 0)
            {
                return null;
            }
            read += chunk;
        }

        var length = BitConverter.ToInt32(lengthBytes, 0);
        var payload = new byte[length];
        var offset = 0;

        while (offset < length)
        {
            var chunk = await input.ReadAsync(payload, offset, length - offset);
            if (chunk == 0)
            {
                return null;
            }
            offset += chunk;
        }

        return Encoding.UTF8.GetString(payload);
    }

    private static async Task WriteMessageAsync(Stream output, string message)
    {
        var payload = Encoding.UTF8.GetBytes(message);
        var lengthBytes = BitConverter.GetBytes(payload.Length);
        await output.WriteAsync(lengthBytes, 0, lengthBytes.Length);
        await output.WriteAsync(payload, 0, payload.Length);
        await output.FlushAsync();
    }

    private static async Task<string> InspectTlsAsync(string? hostname)
    {
        if (string.IsNullOrWhiteSpace(hostname))
        {
            return JsonSerializer.Serialize(new NativeResponse(false, null, "Hostname is required."), JsonOptions);
        }

        var scriptPath = Path.Combine(AppContext.BaseDirectory, "inspect-tls.js");
        if (!File.Exists(scriptPath))
        {
            return JsonSerializer.Serialize(new NativeResponse(false, null, $"Missing helper script: {scriptPath}"), JsonOptions);
        }

        var psi = new ProcessStartInfo
        {
            FileName = "node",
            Arguments = $"\"{scriptPath}\" \"{hostname}\"",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = AppContext.BaseDirectory,
        };

        try
        {
            using var process = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start Node helper.");
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            var stdout = await stdoutTask;
            var stderr = await stderrTask;

            if (process.ExitCode != 0)
            {
                var error = string.IsNullOrWhiteSpace(stderr) ? stdout : stderr;
                return JsonSerializer.Serialize(new NativeResponse(false, null, string.IsNullOrWhiteSpace(error) ? "Node helper failed." : error.Trim()), JsonOptions);
            }

            if (string.IsNullOrWhiteSpace(stdout))
            {
                return JsonSerializer.Serialize(new NativeResponse(false, null, "Node helper returned no data."), JsonOptions);
            }

            return stdout.Trim();
        }
        catch (Exception ex)
        {
            return JsonSerializer.Serialize(new NativeResponse(false, null, ex.ToString()), JsonOptions);
        }
    }

    private sealed record NativeRequest(string? Type, string? Hostname, string? Url);

    private sealed record NativeResponse(bool Ok, object? Certificates, string? Error);
}
