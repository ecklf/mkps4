{
  description = "Native macOS PS4 PS2 Classics builder";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              cargo
              dotnet-sdk_8
              git
              perl
              rustc
            ];

            DOTNET_CLI_TELEMETRY_OPTOUT = "1";
            DOTNET_NOLOGO = "1";
          };

          packaged = pkgs.mkShell {
            packages = with pkgs; [
              cargo
              liborbispkg-pkgtool
              rustc
            ];
          };
        });
    };
}
