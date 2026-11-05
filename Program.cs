using System.Net.Http.Headers;
using Microsoft.AspNetCore.Http.Features;

var builder = WebApplication.CreateSlimBuilder(args);

var vllmUrl = builder.Configuration["VLLM_URL"]?.TrimEnd('/');
if (string.IsNullOrWhiteSpace(vllmUrl))
{
    Console.Error.WriteLine("Set VLLM_URL to the OpenAI-compatible base URL, for example http://10.0.0.5:8000/v1");
    return 1;
}
var apiKey = builder.Configuration["VLLM_API_KEY"];
// One log line per request is noise for a single-user tool. Startup and errors still show.
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);

// With no port setting, listen on the LAN at 7319. The ASP.NET default (localhost:5000) is not
// reachable from other machines, and 5000 and 8080 clash with many other tools.
if (string.IsNullOrEmpty(builder.Configuration["urls"]) && string.IsNullOrEmpty(builder.Configuration["http_ports"]))
    builder.WebHost.UseUrls("http://0.0.0.0:7319");

// Images travel as base64 inside the chat JSON, so the 30 MB Kestrel default is too small.
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 100 * 1024 * 1024);

var app = builder.Build();

// Generation can run for many minutes. The browser ends a request with its stop button, not a timer.
var http = new HttpClient(new SocketsHttpHandler { ConnectTimeout = TimeSpan.FromSeconds(10) })
{
    Timeout = Timeout.InfiniteTimeSpan,
};

var assets = typeof(Program).Assembly.GetManifestResourceNames().ToHashSet();
app.MapGet("/", ctx => ServeAsset(ctx, "index.html"));
app.MapGet("/{file}", ctx => ServeAsset(ctx, (string)ctx.Request.RouteValues["file"]!));

app.MapGet("/api/models", ctx => Forward(ctx, HttpMethod.Get, "models"));
app.MapPost("/api/chat", ctx => Forward(ctx, HttpMethod.Post, "chat/completions"));

Console.WriteLine($"Lantern forwards to {vllmUrl}");
app.Run();
return 0;

async Task ServeAsset(HttpContext ctx, string name)
{
    if (!assets.Contains(name))
    {
        ctx.Response.StatusCode = 404;
        return;
    }
    ctx.Response.ContentType = Path.GetExtension(name) switch
    {
        ".html" => "text/html; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    // The files change with each release, and a stale app.js against a new index.html breaks the page.
    ctx.Response.Headers.CacheControl = "no-cache";
    await using var stream = typeof(Program).Assembly.GetManifestResourceStream(name)!;
    await stream.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
}

// The body passes through as raw bytes in both directions. The server never parses the JSON,
// so it stays independent of vLLM schema changes and needs no serializer metadata for AOT.
async Task Forward(HttpContext ctx, HttpMethod method, string path)
{
    using var request = new HttpRequestMessage(method, $"{vllmUrl}/{path}");
    if (method == HttpMethod.Post)
    {
        request.Content = new StreamContent(ctx.Request.Body);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
    }
    if (!string.IsNullOrEmpty(apiKey))
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);

    try
    {
        // Disposal of the response closes the upstream connection, and vLLM then stops the generation.
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ctx.RequestAborted);
        ctx.Response.StatusCode = (int)response.StatusCode;
        ctx.Response.ContentType = response.Content.Headers.ContentType?.ToString();
        // Each SSE chunk must reach the browser at once, or the text arrives in bursts.
        ctx.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
        await using var body = await response.Content.ReadAsStreamAsync(ctx.RequestAborted);
        await body.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
    }
    catch (OperationCanceledException) when (ctx.RequestAborted.IsCancellationRequested)
    {
        // The user pressed stop or closed the tab. This is normal.
    }
    catch (HttpRequestException e) when (!ctx.Response.HasStarted)
    {
        ctx.Response.StatusCode = StatusCodes.Status502BadGateway;
        ctx.Response.ContentType = "text/plain; charset=utf-8";
        await ctx.Response.WriteAsync($"Cannot reach the model server at {vllmUrl}: {e.Message}");
    }
}
