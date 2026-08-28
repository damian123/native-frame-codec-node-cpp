#include <node_api.h>

#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

namespace {

constexpr std::size_t kDefaultMaxFrameBytes = 16U * 1024U * 1024U;
constexpr std::size_t kMaxBatchBytes = 256U * 1024U * 1024U;
constexpr std::uint32_t kMaxFramesPerBatch = 1'000'000U;

napi_value ThrowLastError(napi_env env, const char* operation) {
  const napi_extended_error_info* error_info = nullptr;
  napi_get_last_error_info(env, &error_info);
  const char* detail =
      error_info != nullptr && error_info->error_message != nullptr
          ? error_info->error_message
          : "unknown Node-API error";
  const std::string message = std::string(operation) + ": " + detail;
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}

#define NAPI_OR_RETURN_NULL(env, operation)        \
  do {                                              \
    if ((operation) != napi_ok) {                  \
      return ThrowLastError((env), #operation);    \
    }                                               \
  } while (false)

napi_value ThrowTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}

napi_value ThrowRangeError(napi_env env, const char* message) {
  napi_throw_range_error(env, nullptr, message);
  return nullptr;
}

bool ReadBuffer(napi_env env, napi_value value, std::uint8_t** data,
                std::size_t* length) {
  bool is_buffer = false;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer) {
    napi_throw_type_error(env, nullptr, "Every frame must be a Node.js Buffer.");
    return false;
  }

  void* raw_data = nullptr;
  if (napi_get_buffer_info(env, value, &raw_data, length) != napi_ok) {
    ThrowLastError(env, "napi_get_buffer_info");
    return false;
  }
  *data = static_cast<std::uint8_t*>(raw_data);
  return true;
}

void WriteBigEndian32(std::uint8_t* target, std::uint32_t value) {
  target[0] = static_cast<std::uint8_t>((value >> 24U) & 0xffU);
  target[1] = static_cast<std::uint8_t>((value >> 16U) & 0xffU);
  target[2] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
  target[3] = static_cast<std::uint8_t>(value & 0xffU);
}

std::uint32_t ReadBigEndian32(const std::uint8_t* source) {
  return (static_cast<std::uint32_t>(source[0]) << 24U) |
         (static_cast<std::uint32_t>(source[1]) << 16U) |
         (static_cast<std::uint32_t>(source[2]) << 8U) |
         static_cast<std::uint32_t>(source[3]);
}

napi_value EncodeFrames(napi_env env, napi_callback_info info) {
  std::size_t argc = 1U;
  napi_value args[1];
  NAPI_OR_RETURN_NULL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
  if (argc != 1U) {
    return ThrowTypeError(env, "encodeFrames expects one array of Buffer values.");
  }

  bool is_array = false;
  NAPI_OR_RETURN_NULL(env, napi_is_array(env, args[0], &is_array));
  if (!is_array) {
    return ThrowTypeError(env, "encodeFrames expects an array.");
  }

  std::uint32_t frame_count = 0U;
  NAPI_OR_RETURN_NULL(env, napi_get_array_length(env, args[0], &frame_count));
  if (frame_count > kMaxFramesPerBatch) {
    return ThrowRangeError(env, "The batch contains too many frames.");
  }

  std::vector<std::uint8_t*> frame_data(frame_count);
  std::vector<std::size_t> frame_lengths(frame_count);
  std::size_t output_bytes = 0U;

  for (std::uint32_t index = 0U; index < frame_count; ++index) {
    napi_value frame;
    NAPI_OR_RETURN_NULL(env, napi_get_element(env, args[0], index, &frame));
    if (!ReadBuffer(env, frame, &frame_data[index], &frame_lengths[index])) {
      return nullptr;
    }
    if (frame_lengths[index] > kDefaultMaxFrameBytes) {
      return ThrowRangeError(env, "A frame exceeds the 16 MiB encoding limit.");
    }
    if (output_bytes > kMaxBatchBytes - 4U - frame_lengths[index]) {
      return ThrowRangeError(env, "The encoded batch exceeds the 256 MiB limit.");
    }
    output_bytes += 4U + frame_lengths[index];
  }

  void* raw_output = nullptr;
  napi_value output;
  NAPI_OR_RETURN_NULL(env, napi_create_buffer(env, output_bytes, &raw_output, &output));
  auto* cursor = static_cast<std::uint8_t*>(raw_output);

  for (std::uint32_t index = 0U; index < frame_count; ++index) {
    WriteBigEndian32(cursor, static_cast<std::uint32_t>(frame_lengths[index]));
    cursor += 4U;
    if (frame_lengths[index] > 0U) {
      std::memcpy(cursor, frame_data[index], frame_lengths[index]);
      cursor += frame_lengths[index];
    }
  }

  return output;
}

napi_value DecodeAvailable(napi_env env, napi_callback_info info) {
  std::size_t argc = 2U;
  napi_value args[2];
  NAPI_OR_RETURN_NULL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
  if (argc < 1U) {
    return ThrowTypeError(env, "decodeAvailable expects a Buffer.");
  }

  std::uint8_t* input = nullptr;
  std::size_t input_bytes = 0U;
  if (!ReadBuffer(env, args[0], &input, &input_bytes)) {
    return nullptr;
  }

  std::uint32_t max_frame_bytes = static_cast<std::uint32_t>(kDefaultMaxFrameBytes);
  if (argc >= 2U) {
    napi_valuetype max_type;
    NAPI_OR_RETURN_NULL(env, napi_typeof(env, args[1], &max_type));
    if (max_type != napi_number) {
      return ThrowTypeError(env, "maxFrameBytes must be a non-negative integer.");
    }
    NAPI_OR_RETURN_NULL(env, napi_get_value_uint32(env, args[1], &max_frame_bytes));
  }

  std::vector<napi_value> frames;
  std::size_t offset = 0U;
  while (input_bytes - offset >= 4U) {
    const std::uint32_t frame_bytes = ReadBigEndian32(input + offset);
    if (frame_bytes > max_frame_bytes) {
      return ThrowRangeError(env, "Frame length exceeds maxFrameBytes.");
    }
    if (input_bytes - offset - 4U < frame_bytes) {
      break;
    }
    if (frames.size() >= kMaxFramesPerBatch) {
      return ThrowRangeError(env, "The decoded batch contains too many frames.");
    }

    napi_value frame;
    void* copied_data = nullptr;
    NAPI_OR_RETURN_NULL(
        env, napi_create_buffer_copy(env, frame_bytes, input + offset + 4U,
                                     &copied_data, &frame));
    frames.push_back(frame);
    offset += 4U + frame_bytes;
  }

  napi_value frame_array;
  NAPI_OR_RETURN_NULL(
      env, napi_create_array_with_length(env, frames.size(), &frame_array));
  for (std::size_t index = 0U; index < frames.size(); ++index) {
    NAPI_OR_RETURN_NULL(
        env, napi_set_element(env, frame_array, static_cast<std::uint32_t>(index),
                              frames[index]));
  }

  napi_value consumed;
  NAPI_OR_RETURN_NULL(
      env, napi_create_double(env, static_cast<double>(offset), &consumed));

  napi_value result;
  NAPI_OR_RETURN_NULL(env, napi_create_object(env, &result));
  NAPI_OR_RETURN_NULL(env, napi_set_named_property(env, result, "frames", frame_array));
  NAPI_OR_RETURN_NULL(env, napi_set_named_property(env, result, "consumed", consumed));
  return result;
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"encodeFrames", nullptr, EncodeFrames, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"decodeAvailable", nullptr, DecodeAvailable, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  NAPI_OR_RETURN_NULL(
      env, napi_define_properties(env, exports,
                                  sizeof(properties) / sizeof(properties[0]),
                                  properties));
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
